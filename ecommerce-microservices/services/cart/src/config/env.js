/**
 * Configuration loader — same pattern as services/catalog/src/config/env.js.
 * Loads the ROOT .env (process env wins), validates every variable this
 * service reads, and returns a frozen config or throws a ConfigError that
 * lists every problem at once.
 *
 * Data-ownership guard: CART_MONGO_URI must name exactly CART_DB_NAME. This
 * service owns cart_db (and its Redis keys) and nothing else.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import bytes from 'bytes';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_ENV_PATH = path.resolve(HERE, '../../../../.env');

export class ConfigError extends Error {
  constructor(problems) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

export function loadDotenv() {
  const envPath = process.env.DOTENV_CONFIG_PATH || ROOT_ENV_PATH;
  const result = dotenv.config({ path: envPath, quiet: true });
  return { path: envPath, loaded: !result.error };
}

const parsers = {
  string: (v) => v,
  int: (v, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
    if (!/^\d+$/.test(v)) throw new Error(`must be a whole number (got "${v}")`);
    const n = Number(v);
    if (n < min || n > max) throw new Error(`must be between ${min} and ${max} (got ${n})`);
    return n;
  },
  port: (v) => parsers.int(v, { min: 1, max: 65535 }),
  bytes: (v) => {
    const n = bytes.parse(v);
    if (n === null || n <= 0) throw new Error(`must be a size like "64kb" (got "${v}")`);
    return n;
  },
  enum: (v, { values }) => {
    if (!values.includes(v)) throw new Error(`must be one of ${values.join(', ')} (got "${v}")`);
    return v;
  },
  url: (v) => {
    let u;
    try { u = new URL(v); } catch { throw new Error(`must be an absolute URL (got "${v}")`); }
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error(`must use http or https (got "${v}")`);
    return v.replace(/\/+$/, '');
  },
  host: (v) => {
    if (!/^[A-Za-z0-9.-]+$/.test(v)) throw new Error(`must be a hostname (got "${v}")`);
    return v;
  },
  keyPrefix: (v) => {
    if (!/^[A-Za-z0-9:_-]{1,32}$/.test(v)) throw new Error(`must be 1-32 chars of letters, digits, ':', '_' or '-' (got "${v}")`);
    return v;
  },
  mongoUri: (v) => {
    let u;
    try { u = new URL(v); } catch { throw new Error('must be a mongodb:// or mongodb+srv:// connection string'); }
    if (!['mongodb:', 'mongodb+srv:'].includes(u.protocol)) throw new Error(`must use mongodb:// or mongodb+srv:// (got "${u.protocol}")`);
    const dbName = u.pathname.replace(/^\//, '');
    if (!dbName) throw new Error('must include the database name in the path, e.g. mongodb://host:27017/cart_db');
    return { uri: v, dbName };
  },
  dbName: (v) => {
    if (!/^[A-Za-z0-9_-]{1,63}$/.test(v)) throw new Error(`must be a valid MongoDB database name (got "${v}")`);
    return v;
  },
};

const schema = {
  NODE_ENV:                             { parse: 'enum', values: ['development', 'test', 'production'] },
  LOG_LEVEL:                            { parse: 'enum', values: ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] },
  CART_PORT:                            { parse: 'port' },
  // MongoDB — the permanent source of truth
  CART_MONGO_URI:                       { parse: 'mongoUri' },
  CART_DB_NAME:                         { parse: 'dbName' },
  CART_MONGO_TIMEOUT_MS:                { parse: 'int', min: 100 },
  CART_MONGO_RETRY_INTERVAL_MS:         { parse: 'int', min: 100 },
  // Redis — the disposable fast copy
  REDIS_HOST:                           { parse: 'host' },
  REDIS_PORT:                           { parse: 'port' },
  REDIS_PASSWORD:                       { parse: 'string' },
  CART_REDIS_KEY_PREFIX:                { parse: 'keyPrefix' },
  CART_REDIS_TTL_SECONDS:               { parse: 'int', min: 1 },
  CART_REDIS_COMMAND_TIMEOUT_MS:        { parse: 'int', min: 50 },
  // Catalog client + circuit breaker
  CATALOG_SERVICE_URL:                  { parse: 'url' },
  CART_CATALOG_TIMEOUT_MS:              { parse: 'int', min: 100 },
  CART_BREAKER_ERROR_THRESHOLD_PERCENT: { parse: 'int', min: 1, max: 100 },
  CART_BREAKER_VOLUME_THRESHOLD:        { parse: 'int', min: 1 },
  CART_BREAKER_RESET_TIMEOUT_MS:        { parse: 'int', min: 100 },
  CART_BREAKER_ROLLING_WINDOW_MS:       { parse: 'int', min: 1000 },
  // Limits
  CART_MAX_QUANTITY_PER_ITEM:           { parse: 'int', min: 1 },
  CART_MAX_LINE_ITEMS:                  { parse: 'int', min: 1 },
  CART_BODY_LIMIT:                      { parse: 'bytes' },
  CART_SHUTDOWN_TIMEOUT_MS:             { parse: 'int', min: 1 },
};

export function loadConfig(env = process.env) {
  const problems = [];
  const values = {};

  for (const [name, rule] of Object.entries(schema)) {
    const raw = env[name];
    if (raw === undefined || String(raw).trim() === '') {
      problems.push(`${name} is required but missing or empty`);
      continue;
    }
    try {
      values[name] = parsers[rule.parse](String(raw).trim(), rule);
    } catch (err) {
      problems.push(`${name} ${err.message}`);
    }
  }

  if (values.CART_MONGO_URI && values.CART_DB_NAME && values.CART_MONGO_URI.dbName !== values.CART_DB_NAME) {
    problems.push(`CART_MONGO_URI points at database "${values.CART_MONGO_URI.dbName}" but this service owns "${values.CART_DB_NAME}" (CART_DB_NAME) — refusing to touch another database`);
  }

  if (problems.length > 0) throw new ConfigError(problems);

  return Object.freeze({
    nodeEnv: values.NODE_ENV,
    logLevel: values.LOG_LEVEL,
    port: values.CART_PORT,
    mongo: Object.freeze({
      uri: values.CART_MONGO_URI.uri,
      dbName: values.CART_DB_NAME,
      timeoutMs: values.CART_MONGO_TIMEOUT_MS,
      retryIntervalMs: values.CART_MONGO_RETRY_INTERVAL_MS,
    }),
    redis: Object.freeze({
      host: values.REDIS_HOST,
      port: values.REDIS_PORT,
      password: values.REDIS_PASSWORD,
      keyPrefix: values.CART_REDIS_KEY_PREFIX,
      ttlSeconds: values.CART_REDIS_TTL_SECONDS,
      commandTimeoutMs: values.CART_REDIS_COMMAND_TIMEOUT_MS,
    }),
    catalog: Object.freeze({
      baseUrl: values.CATALOG_SERVICE_URL,
      timeoutMs: values.CART_CATALOG_TIMEOUT_MS,
      breaker: Object.freeze({
        errorThresholdPercentage: values.CART_BREAKER_ERROR_THRESHOLD_PERCENT,
        volumeThreshold: values.CART_BREAKER_VOLUME_THRESHOLD,
        resetTimeoutMs: values.CART_BREAKER_RESET_TIMEOUT_MS,
        rollingWindowMs: values.CART_BREAKER_ROLLING_WINDOW_MS,
      }),
    }),
    limits: Object.freeze({
      maxQuantityPerItem: values.CART_MAX_QUANTITY_PER_ITEM,
      maxLineItems: values.CART_MAX_LINE_ITEMS,
    }),
    bodyLimitBytes: values.CART_BODY_LIMIT,
    shutdownTimeoutMs: values.CART_SHUTDOWN_TIMEOUT_MS,
  });
}
