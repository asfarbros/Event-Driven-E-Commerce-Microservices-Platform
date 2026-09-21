/**
 * Entry point: load .env → validate config → health endpoint → connect the
 * ledger (retry in background) → connect RabbitMQ and consume (retry forever)
 * → handle signals.
 *
 * Order of shutdown (SIGTERM/SIGINT): stop consuming → drain in-flight
 * deliveries (each acks itself) → close channel + connection → close the
 * channel transport and the ledger → close /health → exit.
 */
import os from 'node:os';
import { createRequire } from 'node:module';
import { loadDotenv, loadConfig, ConfigError } from './config/env.js';
import { createLogger } from './lib/logger.js';
import { createMetrics } from './lib/metrics.js';
import { createMongoConnector } from './db/mongo.js';
import { createDedupeLedger } from './db/dedupe.js';
import { createChannel } from './channels/index.js';
import { createRecipientResolver } from './recipients.js';
import { createProcessor } from './processor.js';
import { createWorker } from './rabbit/worker.js';
import { createHealthServer } from './health.js';

const { version } = createRequire(import.meta.url)('../package.json');

const envFile = loadDotenv();

let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write(`[notification] refusing to start — ${err.message}\n`);
    process.stderr.write(`[notification] env file: ${envFile.path}${envFile.loaded ? '' : ' (not found — relying on process environment only)'}\n`);
    process.exit(1);
  }
  throw err;
}

// Identity of THIS instance (competing consumers are told apart by it in logs, the ledger and the DLQ headers).
const instance = process.env.NOTIFICATION_INSTANCE_ID?.trim() || `${os.hostname()}-${process.pid}`;

const logger = createLogger({ level: config.logLevel, instance });
const metrics = createMetrics();
const mongo = createMongoConnector(config.mongo, logger);
const ledger = createDedupeLedger(config.dedupe, { instance });
const channel = createChannel(config.delivery, logger);
const recipients = createRecipientResolver(config.recipients, logger);
const processor = createProcessor({ config, channel, recipients, ledger });
const worker = createWorker({ config, logger, processor, metrics, instance });
const health = createHealthServer({ config, version, instance, worker, metrics, channel, recipients, ledger, logger });

try {
  const address = await health.listening;
  logger.info(
    {
      port: address.port, env: config.nodeEnv, envFile: envFile.loaded ? envFile.path : null,
      queue: config.rabbit.queue, prefetch: config.rabbit.prefetch, retry: config.retry,
      channel: channel.describe(), recipients: recipients.describe(), ledger: { database: config.mongo.dbName, ...ledger.describe() },
    },
    `notification worker ${instance} — health on http://localhost:${address.port}/health`,
  );
} catch (err) {
  logger.fatal({ err }, `failed to bind port ${config.port}`);
  process.exit(1);
}

await channel.verify?.();
mongo.connectWithRetry().then((connected) => { if (connected) logger.info('dedupe ledger ready'); });
await worker.start();

let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown requested');
    const code = await worker.stop(signal);              // cancel consumer, drain, ack, close AMQP
    await Promise.allSettled([channel.close?.(), mongo.stop(), health.close()]);
    logger.info({ exitCode: code, counters: metrics.snapshot() }, 'notification worker stopped');
    process.exit(code);
  });
}

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled promise rejection');
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception');
  process.exit(1);
});
