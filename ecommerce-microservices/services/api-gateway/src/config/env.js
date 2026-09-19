/**
 * Configuration loader.
 *
 * 1. Loads the ROOT .env (../../../../.env relative to this file). Variables
 *    already present in the process environment win, so Docker / a deployed VM
 *    can inject values without any file. `DOTENV_CONFIG_PATH` overrides the
 *    file location (used by the tests).
 * 2. Validates EVERY variable the gateway needs and returns a typed, frozen
 *    config object. If anything is missing or malformed, `loadConfig` throws a
 *    ConfigError listing all problems at once so the process can exit with a
 *    clear message instead of starting half-configured.
 *
 * Nothing in here has a hardcoded fallback for a real setting: if a value is
 * needed it must come from the environment.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import bytes from 'bytes';
import { routes, validateRoutes } from './routes.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_ENV_PATH = path.resolve(HERE, '../../../../.env');

export class ConfigError extends Error {
  constructor(problems) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/** Load the root .env into process.env (without overriding existing values). */
export function loadDotenv() {
  const envPath = process.env.DOTENV_CONFIG_PATH || ROOT_ENV_PATH;
  const result = dotenv.config({ path: envPath, quiet: true });
  return { path: envPath, loaded: !result.error };
}

// ---------------------------------------------------------------------------
// Parsers: each returns a value or throws an Error whose message explains why.
// ---------------------------------------------------------------------------
const parsers = {
  string: (v) => v,
  int: (v, { min = 0 } = {}) => {
    if (!/^\d+$/.test(v)) throw new Error(`must be a whole number (got "${v}")`);
    const n = Number(v);
    if (n < min) throw new Error(`must be >= ${min} (got ${n})`);
    return n;
  },
  port: (v) => {
    const n = parsers.int(v, { min: 1 });
    if (n > 65535) throw new Error(`must be a port between 1 and 65535 (got ${n})`);
    return n;
  },
  url: (v) => {
    let u;
    try { u = new URL(v); } catch { throw new Error(`must be an absolute URL (got "${v}")`); }
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error(`must use http or https (got "${v}")`);
    return v.replace(/\/+$/, '');
  },
  originList: (v) => {
    const origins = v.split(',').map((s) => s.trim()).filter(Boolean);
    if (origins.length === 0) throw new Error('must list at least one origin');
    for (const o of origins) {
      if (o === '*') throw new Error('wildcard "*" is not allowed because credentials are used');
      let u;
      try { u = new URL(o); } catch { throw new Error(`"${o}" is not a valid origin (e.g. http://localhost:5173)`); }
      if (u.origin !== o) throw new Error(`"${o}" must be a bare origin with no path or trailing slash (use "${u.origin}")`);
    }
    return origins;
  },
  bytes: (v) => {
    const n = bytes.parse(v);
    if (n === null || n <= 0) throw new Error(`must be a size like "1mb" or "512kb" (got "${v}")`);
    return n;
  },
  enum: (v, { values }) => {
    if (!values.includes(v)) throw new Error(`must be one of ${values.join(', ')} (got "${v}")`);
    return v;
  },
  clerkPublishableKey: (v) => {
    // Clerk encodes the Frontend API host as base64 ending in "$" after the
    // pk_test_/pk_live_ prefix. @clerk/backend asserts this on EVERY request,
    // so a leftover placeholder would surface as a 401 on every login instead
    // of a clear boot-time error. Check the same shape here.
    const match = /^pk_(test|live)_([A-Za-z0-9+/=]+)$/.exec(v);
    const decoded = match ? Buffer.from(match[2], 'base64').toString('utf8') : '';
    if (!match || !decoded.endsWith('$')) {
      throw new Error('is not a valid Clerk publishable key (pk_test_… / pk_live_… from dashboard.clerk.com → API Keys)');
    }
    return v;
  },
  clerkSecretKey: (v) => {
    if (!/^sk_(test|live)_[A-Za-z0-9]+$/.test(v)) {
      throw new Error('is not a valid Clerk secret key (sk_test_… / sk_live_… from dashboard.clerk.com → API Keys)');
    }
    return v;
  },
  trustProxy: (v) => {
    // Express "trust proxy" setting. `true` is deliberately rejected: it trusts
    // every X-Forwarded-For header, which lets clients spoof the IP used for
    // rate limiting. Use a hop count or a subnet name instead.
    if (v === 'false') return false;
    if (v === 'true') throw new Error('"true" trusts all proxies and defeats rate limiting; use a hop count (e.g. 1) or "loopback"');
    if (/^\d+$/.test(v)) return Number(v);
    return v; // e.g. "loopback", "uniquelocal", "10.0.0.0/8"
  },
};

// ---------------------------------------------------------------------------
// Schema: every variable the gateway reads. Route target URLs are appended
// from the route table so a new route automatically becomes a required var.
// ---------------------------------------------------------------------------
const schema = {
  NODE_ENV:                     { parse: 'enum', values: ['development', 'test', 'production'] },
  LOG_LEVEL:                    { parse: 'enum', values: ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] },
  GATEWAY_PORT:                 { parse: 'port' },
  CORS_ALLOWED_ORIGINS:         { parse: 'originList' },
  CLERK_PUBLISHABLE_KEY:        { parse: 'clerkPublishableKey' },
  CLERK_SECRET_KEY:             { parse: 'clerkSecretKey' },
  CLERK_JWT_KEY:                { parse: 'string', optional: true },
  CLERK_AUTHORIZED_PARTIES:     { parse: 'originList', optional: true },
  GATEWAY_PROXY_TIMEOUT_MS:     { parse: 'int', min: 1 },
  GATEWAY_RATE_LIMIT_WINDOW_MS: { parse: 'int', min: 1 },
  GATEWAY_RATE_LIMIT_MAX:       { parse: 'int', min: 1 },
  GATEWAY_BODY_LIMIT:           { parse: 'bytes' },
  GATEWAY_SHUTDOWN_TIMEOUT_MS:  { parse: 'int', min: 1 },
  GATEWAY_TRUST_PROXY:          { parse: 'trustProxy' },
};
for (const route of routes) {
  schema[route.targetEnv] = { parse: 'url' };
}

/**
 * Build the config from an environment map (defaults to process.env).
 * @throws {ConfigError} listing every missing / invalid variable.
 */
export function loadConfig(env = process.env) {
  const problems = validateRoutes(routes).map((p) => `route table: ${p}`);
  const values = {};

  for (const [name, rule] of Object.entries(schema)) {
    const raw = env[name];
    const isEmpty = raw === undefined || String(raw).trim() === '';
    if (isEmpty) {
      if (rule.optional) { values[name] = undefined; continue; }
      problems.push(`${name} is required but missing or empty`);
      continue;
    }
    try {
      values[name] = parsers[rule.parse](String(raw).trim(), rule);
    } catch (err) {
      problems.push(`${name} ${err.message}`);
    }
  }

  if (problems.length > 0) throw new ConfigError(problems);

  const serviceUrls = Object.fromEntries(routes.map((r) => [r.targetEnv, values[r.targetEnv]]));

  return Object.freeze({
    nodeEnv: values.NODE_ENV,
    logLevel: values.LOG_LEVEL,
    port: values.GATEWAY_PORT,
    corsOrigins: values.CORS_ALLOWED_ORIGINS,
    clerk: Object.freeze({
      publishableKey: values.CLERK_PUBLISHABLE_KEY,
      secretKey: values.CLERK_SECRET_KEY,
      jwtKey: values.CLERK_JWT_KEY,
      authorizedParties: values.CLERK_AUTHORIZED_PARTIES, // undefined → azp claim not enforced
    }),
    proxyTimeoutMs: values.GATEWAY_PROXY_TIMEOUT_MS,
    rateLimit: Object.freeze({ windowMs: values.GATEWAY_RATE_LIMIT_WINDOW_MS, max: values.GATEWAY_RATE_LIMIT_MAX }),
    bodyLimitBytes: values.GATEWAY_BODY_LIMIT,
    shutdownTimeoutMs: values.GATEWAY_SHUTDOWN_TIMEOUT_MS,
    trustProxy: values.GATEWAY_TRUST_PROXY,
    routes,
    serviceUrls: Object.freeze(serviceUrls),
  });
}
