/**
 * Entry point: load .env → validate config → build app → listen → handle signals.
 *
 * Exits with code 1 and a clear message if configuration is invalid; it never
 * starts half-configured.
 */
import { createRequire } from 'node:module';
import { loadDotenv, loadConfig, ConfigError } from './config/env.js';
import { createLogger } from './lib/logger.js';
import { createApp } from './app.js';
import { startServer } from './server.js';

const { version } = createRequire(import.meta.url)('../package.json');

const envFile = loadDotenv();

let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write(`[api-gateway] refusing to start — ${err.message}\n`);
    process.stderr.write(`[api-gateway] env file: ${envFile.path}${envFile.loaded ? '' : ' (not found — relying on process environment only)'}\n`);
    process.exit(1);
  }
  throw err;
}

const logger = createLogger({ level: config.logLevel });
const app = createApp(config, logger, { version });
const { listening, shutdown } = startServer(app, config, logger);

try {
  const address = await listening;
  logger.info(
    {
      port: address.port,
      env: config.nodeEnv,
      envFile: envFile.loaded ? envFile.path : null,
      corsOrigins: config.corsOrigins,
      routes: config.routes.map((r) => `${r.prefix} -> ${r.name}${r.auth ? ' (auth)' : ''}`),
    },
    `api-gateway listening on http://localhost:${address.port}`,
  );
} catch (err) {
  logger.fatal({ err }, `failed to bind port ${config.port}`);
  process.exit(1);
}

// Graceful shutdown: SIGTERM (Docker / systemd), SIGINT (Ctrl+C).
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, async () => {
    const code = await shutdown(signal);
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
