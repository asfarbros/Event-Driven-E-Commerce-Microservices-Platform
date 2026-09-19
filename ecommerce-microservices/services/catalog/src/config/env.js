/**
 * Configuration loader — same pattern as services/api-gateway/src/config/env.js.
 *
 * 1. Loads the ROOT .env (../../../../.env). Values already in the process
 *    environment win, so Docker / a VM can inject config without a file.
 *    `DOTENV_CONFIG_PATH` overrides the file location (tests use it).
 * 2. Validates every variable this service reads and returns a frozen config.
 *    Missing/invalid values throw a ConfigError listing ALL problems so the
 *    process exits with one clear message instead of starting half-configured.
 *
 * Data-ownership guard: the Mongo URI must name exactly CATALOG_DB_NAME. This
 * service owns catalog_db and nothing else; pointing it anywhere else is a
 * configuration error, not something to tolerate at runtime.
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
    if (n === null || n <= 0) throw new Error(`must be a size like "256kb" or "1mb" (got "${v}")`);
    return n;
  },
  enum: (v, { values }) => {
    if (!values.includes(v)) throw new Error(`must be one of ${values.join(', ')} (got "${v}")`);
    return v;
  },
  currency: (v) => {
    if (!/^[A-Z]{3}$/.test(v)) throw new Error(`must be a 3-letter ISO 4217 code such as INR (got "${v}")`);
    return v;
  },
  mongoUri: (v) => {
    let u;
    try { u = new URL(v); } catch { throw new Error('must be a mongodb:// or mongodb+srv:// connection string'); }
    if (!['mongodb:', 'mongodb+srv:'].includes(u.protocol)) throw new Error(`must use mongodb:// or mongodb+srv:// (got "${u.protocol}")`);
    const dbName = u.pathname.replace(/^\//, '');
    if (!dbName) throw new Error('must include the database name in the path, e.g. mongodb://host:27017/catalog_db');
    return { uri: v, dbName };
  },
  dbName: (v) => {
    if (!/^[A-Za-z0-9_-]{1,63}$/.test(v)) throw new Error(`must be a valid MongoDB database name (got "${v}")`);
    return v;
  },
};

const schema = {
  NODE_ENV:                        { parse: 'enum', values: ['development', 'test', 'production'] },
  LOG_LEVEL:                       { parse: 'enum', values: ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] },
  CATALOG_PORT:                    { parse: 'port' },
  CATALOG_MONGO_URI:               { parse: 'mongoUri' },
  CATALOG_DB_NAME:                 { parse: 'dbName' },
  CATALOG_DEFAULT_CURRENCY:        { parse: 'currency' },
  CATALOG_PAGE_LIMIT_DEFAULT:      { parse: 'int', min: 1, max: 1000 },
  CATALOG_PAGE_LIMIT_MAX:          { parse: 'int', min: 1, max: 1000 },
  CATALOG_PRICE_LOOKUP_MAX_IDS:    { parse: 'int', min: 1, max: 5000 },
  CATALOG_BODY_LIMIT:              { parse: 'bytes' },
  CATALOG_SHUTDOWN_TIMEOUT_MS:     { parse: 'int', min: 1 },
  CATALOG_MONGO_RETRY_INTERVAL_MS: { parse: 'int', min: 100 },
  CATALOG_MONGO_TIMEOUT_MS:        { parse: 'int', min: 100 },
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

  // Cross-field rules (only when the fields themselves parsed).
  if (values.CATALOG_MONGO_URI && values.CATALOG_DB_NAME && values.CATALOG_MONGO_URI.dbName !== values.CATALOG_DB_NAME) {
    problems.push(`CATALOG_MONGO_URI points at database "${values.CATALOG_MONGO_URI.dbName}" but this service owns "${values.CATALOG_DB_NAME}" (CATALOG_DB_NAME) — refusing to touch another database`);
  }
  if (values.CATALOG_PAGE_LIMIT_DEFAULT && values.CATALOG_PAGE_LIMIT_MAX && values.CATALOG_PAGE_LIMIT_DEFAULT > values.CATALOG_PAGE_LIMIT_MAX) {
    problems.push(`CATALOG_PAGE_LIMIT_DEFAULT (${values.CATALOG_PAGE_LIMIT_DEFAULT}) must not exceed CATALOG_PAGE_LIMIT_MAX (${values.CATALOG_PAGE_LIMIT_MAX})`);
  }

  if (problems.length > 0) throw new ConfigError(problems);

  return Object.freeze({
    nodeEnv: values.NODE_ENV,
    logLevel: values.LOG_LEVEL,
    port: values.CATALOG_PORT,
    mongo: Object.freeze({
      uri: values.CATALOG_MONGO_URI.uri,
      dbName: values.CATALOG_DB_NAME,
      retryIntervalMs: values.CATALOG_MONGO_RETRY_INTERVAL_MS,
      timeoutMs: values.CATALOG_MONGO_TIMEOUT_MS,
    }),
    defaultCurrency: values.CATALOG_DEFAULT_CURRENCY,
    pagination: Object.freeze({ defaultLimit: values.CATALOG_PAGE_LIMIT_DEFAULT, maxLimit: values.CATALOG_PAGE_LIMIT_MAX }),
    priceLookupMaxIds: values.CATALOG_PRICE_LOOKUP_MAX_IDS,
    bodyLimitBytes: values.CATALOG_BODY_LIMIT,
    shutdownTimeoutMs: values.CATALOG_SHUTDOWN_TIMEOUT_MS,
  });
}
