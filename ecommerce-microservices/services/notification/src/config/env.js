/**
 * Configuration loader — same pattern as services/cart/src/config/env.js.
 * Loads the ROOT .env (process env wins), validates every variable this
 * worker reads, and returns a frozen config or throws a ConfigError that
 * lists every problem at once.
 *
 * Data-ownership guard: NOTIFICATION_MONGO_URI must name exactly
 * NOTIFICATION_DB_NAME. The only thing this worker stores is its own
 * deduplication ledger (notification_db) — never another service's data.
 *
 * Conditional variables: the SMTP_* block is validated only when
 * NOTIFICATION_CHANNEL=smtp, CLERK_SECRET_KEY only when
 * NOTIFICATION_RECIPIENT_SOURCE=clerk, and NOTIFICATION_STATIC_RECIPIENT only
 * when it is `static` — so a console-only demo needs none of them.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

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
  number: (v, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`must be a number (got "${v}")`);
    if (n < min || n > max) throw new Error(`must be between ${min} and ${max} (got ${n})`);
    return n;
  },
  port: (v) => parsers.int(v, { min: 1, max: 65535 }),
  bool: (v) => {
    if (!['true', 'false'].includes(v.toLowerCase())) throw new Error(`must be true or false (got "${v}")`);
    return v.toLowerCase() === 'true';
  },
  enum: (v, { values }) => {
    if (!values.includes(v)) throw new Error(`must be one of ${values.join(', ')} (got "${v}")`);
    return v;
  },
  host: (v) => {
    if (!/^[A-Za-z0-9.-]+$/.test(v)) throw new Error(`must be a hostname (got "${v}")`);
    return v;
  },
  url: (v) => {
    let u;
    try { u = new URL(v); } catch { throw new Error(`must be an absolute URL (got "${v}")`); }
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error(`must use http or https (got "${v}")`);
    return v.replace(/\/+$/, '');
  },
  amqpUrl: (v) => {
    let u;
    try { u = new URL(v); } catch { throw new Error('must be an amqp:// or amqps:// URL'); }
    if (!['amqp:', 'amqps:'].includes(u.protocol)) throw new Error(`must use amqp:// or amqps:// (got "${u.protocol}")`);
    return v;
  },
  /** RabbitMQ names: letters, digits, dot, dash, underscore — no spaces, no wildcards. */
  amqpName: (v) => {
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(v)) throw new Error(`must be a RabbitMQ name (letters, digits, '.', '_', '-'), got "${v}"`);
    return v;
  },
  email: (v) => {
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(v)) throw new Error(`must be an e-mail address (got "${v}")`);
    return v;
  },
  /** "Name <addr@host>" or a bare address. */
  fromAddress: (v) => {
    if (!/^(?:[^<>]+<)?[^<>\s@]+@[^<>\s@]+>?$/.test(v)) throw new Error(`must be an e-mail address or "Name <address>" (got "${v}")`);
    return v;
  },
  mongoUri: (v) => {
    let u;
    try { u = new URL(v); } catch { throw new Error('must be a mongodb:// or mongodb+srv:// connection string'); }
    if (!['mongodb:', 'mongodb+srv:'].includes(u.protocol)) throw new Error(`must use mongodb:// or mongodb+srv:// (got "${u.protocol}")`);
    const dbName = u.pathname.replace(/^\//, '');
    if (!dbName) throw new Error('must include the database name in the path, e.g. mongodb://host:27017/notification_db');
    return { uri: v, dbName };
  },
  dbName: (v) => {
    if (!/^[A-Za-z0-9_-]{1,63}$/.test(v)) throw new Error(`must be a valid MongoDB database name (got "${v}")`);
    return v;
  },
};

// `when` = only required if the predicate on the raw env holds (validated
// when present either way). `optional` = may be empty.
const schema = {
  NODE_ENV:                              { parse: 'enum', values: ['development', 'test', 'production'] },
  LOG_LEVEL:                             { parse: 'enum', values: ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] },
  NOTIFICATION_PORT:                     { parse: 'port' },
  // RabbitMQ — connection + the Step 6 topology names (shared with the Order Service)
  RABBITMQ_URL:                          { parse: 'amqpUrl' },
  RABBITMQ_NOTIFICATION_EXCHANGE:        { parse: 'amqpName' },
  RABBITMQ_NOTIFICATION_QUEUE:           { parse: 'amqpName' },
  RABBITMQ_NOTIFICATION_DLX:             { parse: 'amqpName' },
  RABBITMQ_NOTIFICATION_DLQ:             { parse: 'amqpName' },
  RABBITMQ_NOTIFICATION_MAX_RETRIES:     { parse: 'int', min: 0, max: 20 },
  RABBITMQ_NOTIFICATION_RETRY_DELAY_MS:  { parse: 'int', min: 100 },
  // Worker-owned retry topology + policy
  RABBITMQ_NOTIFICATION_RETRY_QUEUE:     { parse: 'amqpName' },
  NOTIFICATION_RETRY_BACKOFF_MULTIPLIER: { parse: 'number', min: 1, max: 10 },
  NOTIFICATION_PREFETCH:                 { parse: 'int', min: 1, max: 1000 },
  NOTIFICATION_HEARTBEAT_S:              { parse: 'int', min: 1, max: 600 },
  NOTIFICATION_RECONNECT_MIN_MS:         { parse: 'int', min: 100 },
  NOTIFICATION_RECONNECT_MAX_MS:         { parse: 'int', min: 100 },
  NOTIFICATION_SHUTDOWN_TIMEOUT_MS:      { parse: 'int', min: 1 },
  // Delivery
  NOTIFICATION_CHANNEL:                  { parse: 'enum', values: ['console', 'smtp'] },
  NOTIFICATION_FROM:                     { parse: 'fromAddress' },
  NOTIFICATION_CONSOLE_DELAY_MS:         { parse: 'int', min: 0, max: 60000, optional: true },
  SMTP_HOST:                             { parse: 'host', when: (e) => e.NOTIFICATION_CHANNEL === 'smtp' },
  SMTP_PORT:                             { parse: 'port', when: (e) => e.NOTIFICATION_CHANNEL === 'smtp' },
  SMTP_SECURE:                           { parse: 'bool', when: (e) => e.NOTIFICATION_CHANNEL === 'smtp' },
  SMTP_USER:                             { parse: 'string', optional: true },
  SMTP_PASSWORD:                         { parse: 'string', optional: true },
  SMTP_TIMEOUT_MS:                       { parse: 'int', min: 100, when: (e) => e.NOTIFICATION_CHANNEL === 'smtp' },
  // Recipient resolution (the command carries a userId, not an address)
  NOTIFICATION_RECIPIENT_SOURCE:         { parse: 'enum', values: ['clerk', 'static'] },
  NOTIFICATION_STATIC_RECIPIENT:         { parse: 'email', when: (e) => e.NOTIFICATION_RECIPIENT_SOURCE === 'static' },
  CLERK_SECRET_KEY:                      { parse: 'string', when: (e) => e.NOTIFICATION_RECIPIENT_SOURCE === 'clerk' },
  NOTIFICATION_CLERK_API_URL:            { parse: 'url', when: (e) => e.NOTIFICATION_RECIPIENT_SOURCE === 'clerk' },
  NOTIFICATION_CLERK_TIMEOUT_MS:         { parse: 'int', min: 100, when: (e) => e.NOTIFICATION_RECIPIENT_SOURCE === 'clerk' },
  NOTIFICATION_RECIPIENT_CACHE_TTL_S:    { parse: 'int', min: 0 },
  // Deduplication ledger (MongoDB, owned by this worker)
  NOTIFICATION_MONGO_URI:                { parse: 'mongoUri' },
  NOTIFICATION_DB_NAME:                  { parse: 'dbName' },
  NOTIFICATION_MONGO_TIMEOUT_MS:         { parse: 'int', min: 100 },
  NOTIFICATION_MONGO_RETRY_INTERVAL_MS:  { parse: 'int', min: 100 },
  NOTIFICATION_DEDUPE_RETENTION_HOURS:   { parse: 'int', min: 1 },
  NOTIFICATION_DEDUPE_CLAIM_TTL_MS:      { parse: 'int', min: 1000 },
};

export function loadConfig(env = process.env) {
  const problems = [];
  const values = {};

  for (const [name, rule] of Object.entries(schema)) {
    const raw = env[name];
    const missing = raw === undefined || String(raw).trim() === '';
    if (missing) {
      if (rule.optional) { values[name] = ''; continue; }
      if (rule.when && !rule.when(env)) { values[name] = undefined; continue; }
      problems.push(`${name} is required but missing or empty${rule.when ? ' (needed for the selected mode)' : ''}`);
      continue;
    }
    try {
      values[name] = parsers[rule.parse](String(raw).trim(), rule);
    } catch (err) {
      problems.push(`${name} ${err.message}`);
    }
  }

  if (values.NOTIFICATION_MONGO_URI && values.NOTIFICATION_DB_NAME && values.NOTIFICATION_MONGO_URI.dbName !== values.NOTIFICATION_DB_NAME) {
    problems.push(`NOTIFICATION_MONGO_URI points at database "${values.NOTIFICATION_MONGO_URI.dbName}" but this worker owns "${values.NOTIFICATION_DB_NAME}" (NOTIFICATION_DB_NAME) — refusing to touch another database`);
  }
  if (values.NOTIFICATION_RECONNECT_MIN_MS && values.NOTIFICATION_RECONNECT_MAX_MS && values.NOTIFICATION_RECONNECT_MIN_MS > values.NOTIFICATION_RECONNECT_MAX_MS) {
    problems.push('NOTIFICATION_RECONNECT_MIN_MS must not exceed NOTIFICATION_RECONNECT_MAX_MS');
  }
  const names = ['RABBITMQ_NOTIFICATION_EXCHANGE', 'RABBITMQ_NOTIFICATION_QUEUE', 'RABBITMQ_NOTIFICATION_DLX', 'RABBITMQ_NOTIFICATION_DLQ', 'RABBITMQ_NOTIFICATION_RETRY_QUEUE']
    .map((n) => values[n]).filter(Boolean);
  if (new Set(names).size !== names.length) {
    problems.push('RabbitMQ exchange / queue names must all be distinct');
  }

  if (problems.length > 0) throw new ConfigError(problems);

  // Retry k (1-based) waits base * multiplier^(k-1) ms. Computed ONCE here so
  // the topology (one retry queue per delay) and the policy never disagree.
  const retryDelaysMs = Array.from({ length: values.RABBITMQ_NOTIFICATION_MAX_RETRIES }, (_, i) =>
    Math.round(values.RABBITMQ_NOTIFICATION_RETRY_DELAY_MS * values.NOTIFICATION_RETRY_BACKOFF_MULTIPLIER ** i));

  return Object.freeze({
    nodeEnv: values.NODE_ENV,
    logLevel: values.LOG_LEVEL,
    port: values.NOTIFICATION_PORT,
    rabbit: Object.freeze({
      url: values.RABBITMQ_URL,
      exchange: values.RABBITMQ_NOTIFICATION_EXCHANGE,
      queue: values.RABBITMQ_NOTIFICATION_QUEUE,
      deadLetterExchange: values.RABBITMQ_NOTIFICATION_DLX,
      deadLetterQueue: values.RABBITMQ_NOTIFICATION_DLQ,
      retryQueue: values.RABBITMQ_NOTIFICATION_RETRY_QUEUE,
      prefetch: values.NOTIFICATION_PREFETCH,
      heartbeatSeconds: values.NOTIFICATION_HEARTBEAT_S,
      reconnectMinMs: values.NOTIFICATION_RECONNECT_MIN_MS,
      reconnectMaxMs: values.NOTIFICATION_RECONNECT_MAX_MS,
    }),
    retry: Object.freeze({
      maxRetries: values.RABBITMQ_NOTIFICATION_MAX_RETRIES,
      maxAttempts: values.RABBITMQ_NOTIFICATION_MAX_RETRIES + 1,
      delaysMs: Object.freeze(retryDelaysMs),
    }),
    delivery: Object.freeze({
      channel: values.NOTIFICATION_CHANNEL,
      from: values.NOTIFICATION_FROM,
      consoleDelayMs: values.NOTIFICATION_CONSOLE_DELAY_MS || 0,
      smtp: values.NOTIFICATION_CHANNEL === 'smtp' ? Object.freeze({
        host: values.SMTP_HOST,
        port: values.SMTP_PORT,
        secure: values.SMTP_SECURE,
        user: values.SMTP_USER || undefined,
        password: values.SMTP_PASSWORD || undefined,
        timeoutMs: values.SMTP_TIMEOUT_MS,
      }) : null,
    }),
    recipients: Object.freeze({
      source: values.NOTIFICATION_RECIPIENT_SOURCE,
      staticRecipient: values.NOTIFICATION_STATIC_RECIPIENT,
      clerkSecretKey: values.CLERK_SECRET_KEY,
      clerkApiUrl: values.NOTIFICATION_CLERK_API_URL,
      clerkTimeoutMs: values.NOTIFICATION_CLERK_TIMEOUT_MS,
      cacheTtlSeconds: values.NOTIFICATION_RECIPIENT_CACHE_TTL_S,
    }),
    mongo: Object.freeze({
      uri: values.NOTIFICATION_MONGO_URI.uri,
      dbName: values.NOTIFICATION_DB_NAME,
      timeoutMs: values.NOTIFICATION_MONGO_TIMEOUT_MS,
      retryIntervalMs: values.NOTIFICATION_MONGO_RETRY_INTERVAL_MS,
    }),
    dedupe: Object.freeze({
      retentionHours: values.NOTIFICATION_DEDUPE_RETENTION_HOURS,
      claimTtlMs: values.NOTIFICATION_DEDUPE_CLAIM_TTL_MS,
    }),
    shutdownTimeoutMs: values.NOTIFICATION_SHUTDOWN_TIMEOUT_MS,
  });
}
