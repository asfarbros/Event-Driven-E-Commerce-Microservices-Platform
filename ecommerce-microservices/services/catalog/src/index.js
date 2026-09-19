/**
 * Entry point: load .env → validate config → listen → connect to MongoDB
 * (with retry) → handle signals.
 *
 * The HTTP server is started BEFORE the database is reachable so that
 * /health can report the real DB state while we retry; product routes answer
 * 503 until the connection is up.
 */
import { createRequire } from 'node:module';
import { loadDotenv, loadConfig, ConfigError } from './config/env.js';
import { createLogger } from './lib/logger.js';
import { createMongoConnector } from './db/mongo.js';
import { createApp } from './app.js';
import { startServer } from './server.js';

const { version } = createRequire(import.meta.url)('../package.json');

const envFile = loadDotenv();

let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write(`[catalog] refusing to start — ${err.message}\n`);
    process.stderr.write(`[catalog] env file: ${envFile.path}${envFile.loaded ? '' : ' (not found — relying on process environment only)'}\n`);
    process.exit(1);
  }
  throw err;
}

const logger = createLogger({ level: config.logLevel });
const mongo = createMongoConnector(config.mongo, logger);
const app = createApp(config, logger, { version });
const { listening, shutdown } = startServer(app, config, logger);

try {
  const address = await listening;
  logger.info(
    { port: address.port, env: config.nodeEnv, envFile: envFile.loaded ? envFile.path : null, database: config.mongo.dbName },
    `catalog listening on http://localhost:${address.port}`,
  );
} catch (err) {
  logger.fatal({ err }, `failed to bind port ${config.port}`);
  process.exit(1);
}

// Not awaited: keeps retrying in the background; /health shows the state.
mongo.connectWithRetry().then((connected) => {
  if (connected) logger.info('catalog ready: database connected');
});

// Graceful shutdown: HTTP first (finish in-flight requests), then MongoDB.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, async () => {
    const code = await shutdown(signal);
    await mongo.stop();
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
