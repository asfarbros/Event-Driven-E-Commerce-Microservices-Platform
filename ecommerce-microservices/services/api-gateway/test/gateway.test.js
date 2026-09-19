/**
 * Integration tests: real HTTP server, real proxying, real Clerk middleware
 * (rejection paths only — see helpers/test-env.js). Run with `npm test`.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadConfig, ConfigError } from '../src/config/env.js';
import { createLogger } from '../src/lib/logger.js';
import { createApp } from '../src/app.js';
import { startServer } from '../src/server.js';
import { startEchoServer } from './helpers/echo-server.js';
import { testEnv, UNREACHABLE } from './helpers/test-env.js';

const logger = createLogger({ level: 'silent' });
const ALLOWED_ORIGIN = 'http://localhost:5173';
const EVIL_ORIGIN = 'http://evil.example.com';

async function boot(envOverrides = {}) {
  const config = loadConfig(testEnv(envOverrides));
  const app = createApp(config, logger, { version: 'test' });
  const { server, listening, shutdown } = startServer(app, { port: 0, host: '127.0.0.1', shutdownTimeoutMs: config.shutdownTimeoutMs }, logger);
  const { port } = await listening;
  return { base: `http://127.0.0.1:${port}`, server, shutdown, config };
}

const json = async (res) => ({ status: res.status, headers: res.headers, body: await res.json() });

// ---------------------------------------------------------------------------
describe('gateway with every downstream service down', () => {
  let gw;
  before(async () => { gw = await boot(); });
  after(() => { gw.server.closeAllConnections(); gw.server.close(); });

  test('starts and GET /health is 200 without any downstream', async () => {
    const r = await json(await fetch(`${gw.base}/health`));
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'ok');
    assert.equal(r.body.service, 'api-gateway');
    assert.equal(typeof r.body.uptimeSeconds, 'number');
    assert.match(r.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
  });

  test('public route → 503 JSON naming the service, no internal details', async () => {
    const r = await json(await fetch(`${gw.base}/api/catalog/products`));
    assert.equal(r.status, 503);
    assert.equal(r.body.error, 'service_unavailable');
    assert.match(r.body.message, /catalog service/);
    assert.doesNotMatch(JSON.stringify(r.body), /127\.0\.0\.1|:9\b|ECONNREFUSED|at /);
    assert.equal(typeof r.body.requestId, 'string');
  });

  test('protected route without token → 401 JSON (auth checked before proxying)', async () => {
    for (const p of ['/api/cart', '/api/orders/1', '/api/payments/x', '/api/inventory/y']) {
      const r = await json(await fetch(`${gw.base}${p}`));
      assert.equal(r.status, 401, p);
      assert.equal(r.body.error, 'unauthorized');
      assert.equal(typeof r.body.requestId, 'string');
    }
  });

  test('protected route with malformed token → 401 JSON', async () => {
    const r = await json(await fetch(`${gw.base}/api/cart`, { headers: { Authorization: 'Bearer definitely-not-a-jwt' } }));
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'unauthorized');
    assert.equal(r.body.message, 'Invalid or expired token');
  });

  test('protected route with a forged (unsigned) JWT → 401 JSON', async () => {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const forged = `${b64({ alg: 'RS256', kid: 'nope', typ: 'JWT' })}.${b64({ sub: 'user_forged', exp: 4102444800, iat: 1, iss: 'https://x' })}.c2ln`;
    const r = await json(await fetch(`${gw.base}/api/orders`, { headers: { Authorization: `Bearer ${forged}` } }));
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'unauthorized');
  });

  test('preflight from allowed origin → 204 with Authorization allowed, no auth required', async () => {
    const res = await fetch(`${gw.base}/api/cart/items`, {
      method: 'OPTIONS',
      headers: { Origin: ALLOWED_ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
    assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
    assert.match(res.headers.get('access-control-allow-headers'), /authorization/i);
    assert.match(res.headers.get('access-control-allow-methods'), /POST/);
    assert.match(res.headers.get('vary'), /Origin/);
  });

  test('request from non-allowed origin gets no CORS grant; its preflight is 403', async () => {
    const plain = await fetch(`${gw.base}/health`, { headers: { Origin: EVIL_ORIGIN } });
    assert.equal(plain.status, 200);
    assert.equal(plain.headers.get('access-control-allow-origin'), null);
    assert.equal(plain.headers.get('access-control-allow-credentials'), null);

    const preflight = await json(await fetch(`${gw.base}/api/cart`, {
      method: 'OPTIONS',
      headers: { Origin: EVIL_ORIGIN, 'Access-Control-Request-Method': 'POST' },
    }));
    assert.equal(preflight.status, 403);
    assert.equal(preflight.body.error, 'origin_not_allowed');
    assert.equal(preflight.headers.get('access-control-allow-origin'), null);
  });

  test('never wildcards: allowed origin is echoed, not *', async () => {
    const res = await fetch(`${gw.base}/health`, { headers: { Origin: 'https://shop.example.com' } });
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://shop.example.com');
  });

  test('unknown route → 404 JSON', async () => {
    const r = await json(await fetch(`${gw.base}/nope`));
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'not_found');
  });

  test('prefix matching is segment-safe: /api/catalogue is not the catalog route', async () => {
    const r = await json(await fetch(`${gw.base}/api/catalogue/x`));
    assert.equal(r.status, 404);
  });

  test('oversized Content-Length → 413 JSON before proxying', async () => {
    const r = await json(await fetch(`${gw.base}/api/catalog/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(64 * 1024 + 1) },
      body: Buffer.alloc(64 * 1024 + 1),
    }));
    assert.equal(r.status, 413);
    assert.equal(r.body.error, 'payload_too_large');
  });

  test('security headers (helmet) are present', async () => {
    const res = await fetch(`${gw.base}/health`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-powered-by'), null);
    assert.ok(res.headers.get('content-security-policy'));
  });
});

// ---------------------------------------------------------------------------
describe('proxying to a reachable service (echo fixture as the catalog)', () => {
  let echo, gw;
  before(async () => {
    echo = await startEchoServer();
    gw = await boot({ CATALOG_SERVICE_URL: echo.url });
  });
  after(async () => { gw.server.closeAllConnections(); gw.server.close(); await echo.close(); });

  test('strips the /api/catalog prefix, keeps the rest of the path and query', async () => {
    const r = await json(await fetch(`${gw.base}/api/catalog/products/42?sort=price&page=2`));
    assert.equal(r.status, 200);
    assert.equal(r.body.url, '/products/42?sort=price&page=2');
    assert.equal(r.body.method, 'GET');
  });

  test('bare prefix forwards as /', async () => {
    const r = await json(await fetch(`${gw.base}/api/catalog`));
    assert.equal(r.body.url, '/');
    const q = await json(await fetch(`${gw.base}/api/catalog?q=shoes`));
    assert.equal(q.body.url, '/?q=shoes');
  });

  test('SPOOFING GUARD: a client-supplied X-User-Id never reaches the service', async () => {
    const r = await json(await fetch(`${gw.base}/api/catalog/me`, {
      headers: { 'X-User-Id': 'user_victim', 'x-session-id': 'sess_forged' },
    }));
    assert.equal(r.status, 200);
    assert.equal(r.body.headers['x-user-id'], undefined, 'x-user-id must be stripped');
    assert.equal(r.body.headers['x-session-id'], undefined, 'x-session-id must be stripped');
  });

  test('correlation id: inbound X-Request-Id is reused, echoed back and forwarded', async () => {
    const r = await json(await fetch(`${gw.base}/api/catalog/products`, { headers: { 'X-Request-Id': 'trace-abc.123' } }));
    assert.equal(r.headers.get('x-request-id'), 'trace-abc.123');
    assert.equal(r.body.headers['x-request-id'], 'trace-abc.123');
  });

  test('correlation id: a malformed inbound id is replaced by a fresh UUID', async () => {
    const r = await json(await fetch(`${gw.base}/api/catalog/products`, { headers: { 'X-Request-Id': 'bad id with spaces <script>' } }));
    assert.match(r.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
    assert.equal(r.body.headers['x-request-id'], r.headers.get('x-request-id'));
  });

  test('forwarding metadata: X-Forwarded-* set, Host rewritten to the target', async () => {
    const r = await json(await fetch(`${gw.base}/api/catalog/products`));
    assert.ok(r.body.headers['x-forwarded-for']);
    assert.equal(r.body.headers['x-forwarded-proto'], 'http');
    assert.equal(r.body.headers.host, new URL(echo.url).host);
  });

  test('request bodies stream through untouched (60 KB upload under the 64 KB limit)', async () => {
    const size = 60 * 1024;
    const r = await json(await fetch(`${gw.base}/api/catalog/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.alloc(size, 1),
    }));
    assert.equal(r.status, 200);
    assert.equal(r.body.method, 'POST');
    assert.equal(r.body.bodyBytes, size);
  });

  test('upstream response headers and status pass through', async () => {
    const res = await fetch(`${gw.base}/api/catalog/products`);
    assert.equal(res.headers.get('x-echo'), 'true');
    assert.equal(res.headers.get('content-type'), 'application/json');
  });

  test('slow upstream → 503 JSON after GATEWAY_PROXY_TIMEOUT_MS', async () => {
    const started = Date.now();
    const r = await json(await fetch(`${gw.base}/api/catalog/slow?delay=3000`));
    const elapsed = Date.now() - started;
    assert.equal(r.status, 503);
    assert.equal(r.body.error, 'service_unavailable');
    assert.match(r.body.message, /catalog service did not respond in time/);
    assert.ok(elapsed < 2500, `answered in ${elapsed}ms (timeout is 1000ms)`);
  });
});

// ---------------------------------------------------------------------------
describe('rate limiting', () => {
  test('requests beyond GATEWAY_RATE_LIMIT_MAX → 429 JSON; /health is exempt', async () => {
    const gw = await boot({ GATEWAY_RATE_LIMIT_MAX: '3' });
    try {
      const statuses = [];
      for (let i = 0; i < 5; i++) statuses.push((await fetch(`${gw.base}/api/catalog/x`)).status);
      assert.deepEqual(statuses, [503, 503, 503, 429, 429]);
      const limited = await json(await fetch(`${gw.base}/api/catalog/x`));
      assert.equal(limited.body.error, 'rate_limited');
      assert.ok(limited.headers.get('ratelimit'), 'RateLimit header present');
      assert.equal((await fetch(`${gw.base}/health`)).status, 200);
    } finally {
      gw.server.closeAllConnections();
      gw.server.close();
    }
  });
});

// ---------------------------------------------------------------------------
describe('configuration validation', () => {
  test('loadConfig lists every missing / invalid variable at once', () => {
    const env = testEnv({ CLERK_SECRET_KEY: '', CATALOG_SERVICE_URL: 'not-a-url', CORS_ALLOWED_ORIGINS: '*', GATEWAY_TRUST_PROXY: 'true' });
    assert.throws(() => loadConfig(env), (err) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /CLERK_SECRET_KEY is required/);
      assert.match(err.message, /CATALOG_SERVICE_URL must be an absolute URL/);
      assert.match(err.message, /CORS_ALLOWED_ORIGINS wildcard/);
      assert.match(err.message, /GATEWAY_TRUST_PROXY "true"/);
      return true;
    });
  });

  test('a placeholder Clerk publishable key is rejected at boot', () => {
    assert.throws(() => loadConfig(testEnv({ CLERK_PUBLISHABLE_KEY: 'pk_test_xxxxxxxxxxxxxxxxxxxxxxxx' })), /CLERK_PUBLISHABLE_KEY is not a valid/);
  });

  test('the real process exits 1 naming the missing variable', async () => {
    const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/index.js');
    const env = { PATH: process.env.PATH, DOTENV_CONFIG_PATH: '/nonexistent/.env', ...testEnv() };
    delete env.ORDER_SERVICE_URL;
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [entry], { env, windowsHide: true });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (code) => resolve({ code, stderr }));
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /refusing to start/);
    assert.match(result.stderr, /ORDER_SERVICE_URL is required/);
  });
});

// ---------------------------------------------------------------------------
describe('graceful shutdown', () => {
  test('in-flight request completes, then the server closes; new connections are refused', async () => {
    const echo = await startEchoServer();
    const gw = await boot({ CATALOG_SERVICE_URL: echo.url, GATEWAY_PROXY_TIMEOUT_MS: '5000' });

    const inFlight = fetch(`${gw.base}/api/catalog/slow?delay=600`);
    await new Promise((r) => setTimeout(r, 100)); // make sure it is in flight
    const exitCode = gw.shutdown('test');

    const res = await inFlight;
    assert.equal(res.status, 200, 'in-flight request finished normally');
    assert.equal((await res.json()).url, '/slow?delay=600');

    assert.equal(await exitCode, 0, 'closed within the grace period');
    await assert.rejects(fetch(`${gw.base}/health`), 'server no longer accepts connections');
    await echo.close();
  });
});
