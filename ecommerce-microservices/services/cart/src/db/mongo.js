/**
 * MongoDB connection lifecycle (Mongoose).
 *
 * Resilience contract:
 *   - Connecting never throws out of `connectWithRetry`: on failure it logs a
 *     clear line (host + reason, never the credentials) and retries every
 *     `retryIntervalMs` until it succeeds or `stop()` is called. The HTTP
 *     server starts regardless, so /health can report the real DB state.
 *   - Once connected, the driver reconnects on its own; we just log the
 *     transitions.
 *   - Command buffering is OFF: while disconnected, a query fails immediately
 *     (→ 503 via requireDatabase / the error handler) instead of hanging for
 *     10 s and then failing anyway.
 */
import mongoose from 'mongoose';
import { HttpError } from '../lib/http-error.js';

const STATE_NAMES = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting', 99: 'uninitialized' };

export function describeConnection() {
  const conn = mongoose.connection;
  return {
    state: STATE_NAMES[conn.readyState] ?? 'unknown',
    connected: conn.readyState === 1,
    database: conn.name ?? null,
    host: conn.host ? `${conn.host}:${conn.port}` : null,
  };
}

export function isConnected() {
  return mongoose.connection.readyState === 1;
}

/** Redact credentials for logs: mongodb://user:pass@host → mongodb://***@host */
function safeUri(uri) {
  return uri.replace(/\/\/[^@/]+@/, '//***@');
}

export function createMongoConnector({ uri, dbName, retryIntervalMs, timeoutMs }, logger) {
  const log = logger.child({ component: 'mongo', uri: safeUri(uri) });
  let stopped = false;
  let retryTimer = null;
  let attempts = 0;

  mongoose.set('bufferCommands', false);
  mongoose.set('strictQuery', true); // unknown filter fields are dropped, never passed through

  const conn = mongoose.connection;
  conn.on('connected', () => log.info({ database: conn.name, host: `${conn.host}:${conn.port}` }, 'mongodb connected'));
  conn.on('disconnected', () => { if (!stopped) log.warn('mongodb disconnected — driver will keep trying to reconnect'); });
  conn.on('reconnected', () => log.info('mongodb reconnected'));
  conn.on('error', (err) => log.error({ err: { name: err.name, message: err.message } }, 'mongodb connection error'));

  async function attempt() {
    attempts += 1;
    try {
      await mongoose.connect(uri, {
        dbName,
        serverSelectionTimeoutMS: timeoutMs,
        connectTimeoutMS: timeoutMs,
        appName: 'orderflow-cart',
      });
      attempts = 0;
      return true;
    } catch (err) {
      log.error(
        { attempt: attempts, retryInMs: retryIntervalMs, reason: err.message?.split('\n')[0] },
        'mongodb unreachable — will retry',
      );
      return false;
    }
  }

  /** Resolves when connected; keeps retrying in the background until then. */
  function connectWithRetry() {
    return new Promise((resolve) => {
      const loop = async () => {
        if (stopped) return resolve(false);
        if (await attempt()) return resolve(true);
        retryTimer = setTimeout(loop, retryIntervalMs);
      };
      loop();
    });
  }

  async function stop() {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    if (conn.readyState !== 0) {
      await mongoose.disconnect();
      log.info('mongodb connection closed');
    }
  }

  return { connectWithRetry, stop };
}

/**
 * Route guard for anything that needs the database: answer 503 immediately
 * while disconnected rather than letting the request hit a closed driver.
 */
export function requireDatabase() {
  return (req, res, next) => {
    if (isConnected()) return next();
    next(new HttpError(503, 'database_unavailable', 'The cart database is temporarily unavailable. Please try again.'));
  };
}
