/**
 * MongoDB connection lifecycle (Mongoose) — same contract as Cart's:
 *   - connectWithRetry() never throws; it logs (host, never credentials) and
 *     retries every retryIntervalMs until connected or stop() is called.
 *   - Once connected the driver reconnects on its own; we log transitions.
 *   - Command buffering is OFF: while disconnected a ledger operation fails
 *     immediately, which the consumer treats as a TRANSIENT failure (the
 *     message goes to the retry queue rather than being sent un-deduplicated).
 */
import mongoose from 'mongoose';
import { maskUrl } from '../lib/redact.js';

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

export function createMongoConnector({ uri, dbName, retryIntervalMs, timeoutMs }, logger) {
  const log = logger.child({ component: 'mongo', target: maskUrl(uri) });
  let stopped = false;
  let retryTimer = null;
  let attempts = 0;

  mongoose.set('bufferCommands', false);
  mongoose.set('strictQuery', true);

  const conn = mongoose.connection;
  conn.on('connected', () => log.info({ database: conn.name, host: `${conn.host}:${conn.port}` }, 'mongodb connected'));
  conn.on('disconnected', () => { if (!stopped) log.warn('mongodb disconnected — driver will keep trying to reconnect'); });
  conn.on('reconnected', () => log.info('mongodb reconnected'));
  conn.on('error', (err) => log.error({ error: { name: err.name, message: err.message } }, 'mongodb connection error'));

  async function attempt() {
    attempts += 1;
    try {
      await mongoose.connect(uri, {
        dbName,
        serverSelectionTimeoutMS: timeoutMs,
        connectTimeoutMS: timeoutMs,
        appName: 'orderflow-notification',
      });
      attempts = 0;
      return true;
    } catch (err) {
      log.error({ attempt: attempts, retryInMs: retryIntervalMs, reason: err.message?.split('\n')[0] }, 'mongodb unreachable — will retry');
      return false;
    }
  }

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
