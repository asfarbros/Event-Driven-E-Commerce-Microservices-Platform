/**
 * Entry point: load .env → validate config → listen → connect MongoDB (retry)
 * and Redis (best effort) → handle signals.
 *
 * MongoDB is REQUIRED (cart routes answer 503 until it is up). Redis is
 * OPTIONAL: if it is down at boot or later, reads and writes go straight to
 * MongoDB and /health shows `redis.connected: false`.
 */
import { createRequire } from 'node:module';
import { loadDotenv, loadConfig, ConfigError } from './config/env.js';
import { createLogger } from './lib/logger.js';
import { createMongoConnector } from './db/mongo.js';
import { createCartCache } from './db/redis.js';
import { createCatalogClient } from './clients/catalog.js';
import { createApp } from './app.js';
import { startServer } from './server.js';

const { version } = createRequire(import.meta.url)('../package.json');

const envFile = loadDotenv();

let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write(`[cart] refusing to start — ${err.message}\n`);
    process.stderr.write(`[cart] env file: ${envFile.path}${envFile.loaded ? '' : ' (not found — relying on process environment only)'}\n`);
    process.exit(1);
  }
  throw err;
}

const logger = createLogger({ level: config.logLevel });
const mongo = createMongoConnector(config.mongo, logger);
const cache = createCartCache(config.redis, logger);
const catalog = createCatalogClient(config.catalog, logger);
const app = createApp(config, logger, { version, cache, catalog });
const { listening, shutdown } = startServer(app, config, logger);

try {
  const address = await listening;
  logger.info(
    {
      port: address.port, env: config.nodeEnv, envFile: envFile.loaded ? envFile.path : null,
      database: config.mongo.dbName, redis: `${config.redis.host}:${config.redis.port}`, catalog: config.catalog.baseUrl,
      breaker: config.catalog.breaker,
    },
    `cart listening on http://localhost:${address.port}`,
  );
} catch (err) {
  logger.fatal({ err }, `failed to bind port ${config.port}`);
  process.exit(1);
}

cache.connect(); // best effort, never blocks startup
mongo.connectWithRetry().then((connected) => {
  if (connected) logger.info('cart ready: database connected');
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, async () => {
    const code = await shutdown(signal);   // HTTP first: finish in-flight requests
    catalog.stop();
    await Promise.all([mongo.stop(), cache.stop()]);
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
