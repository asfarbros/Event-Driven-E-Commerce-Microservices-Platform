import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigError } from '../src/config/env.js';

const base = {
  NODE_ENV: 'test', LOG_LEVEL: 'silent', NOTIFICATION_PORT: '4003',
  RABBITMQ_URL: 'amqp://u:p@localhost:5672',
  RABBITMQ_NOTIFICATION_EXCHANGE: 'notifications', RABBITMQ_NOTIFICATION_QUEUE: 'notification.tasks',
  RABBITMQ_NOTIFICATION_DLX: 'notifications.dlx', RABBITMQ_NOTIFICATION_DLQ: 'notification.tasks.dlq',
  RABBITMQ_NOTIFICATION_MAX_RETRIES: '3', RABBITMQ_NOTIFICATION_RETRY_DELAY_MS: '5000',
  RABBITMQ_NOTIFICATION_RETRY_QUEUE: 'notification.tasks.retry', NOTIFICATION_RETRY_BACKOFF_MULTIPLIER: '2',
  NOTIFICATION_PREFETCH: '5', NOTIFICATION_HEARTBEAT_S: '15', NOTIFICATION_RECONNECT_MIN_MS: '1000', NOTIFICATION_RECONNECT_MAX_MS: '30000',
  NOTIFICATION_SHUTDOWN_TIMEOUT_MS: '10000',
  NOTIFICATION_CHANNEL: 'console', NOTIFICATION_FROM: 'OrderFlow <no-reply@orderflow.local>',
  NOTIFICATION_RECIPIENT_SOURCE: 'static', NOTIFICATION_STATIC_RECIPIENT: 'customer@example.com', NOTIFICATION_RECIPIENT_CACHE_TTL_S: '600',
  NOTIFICATION_MONGO_URI: 'mongodb://root:x@localhost:27017/notification_db?authSource=admin', NOTIFICATION_DB_NAME: 'notification_db',
  NOTIFICATION_MONGO_TIMEOUT_MS: '3000', NOTIFICATION_MONGO_RETRY_INTERVAL_MS: '2000',
  NOTIFICATION_DEDUPE_RETENTION_HOURS: '168', NOTIFICATION_DEDUPE_CLAIM_TTL_MS: '60000',
};

test('valid console/static config loads and derives the backoff schedule', () => {
  const cfg = loadConfig(base);
  assert.deepEqual(cfg.retry, { maxRetries: 3, maxAttempts: 4, delaysMs: [5000, 10000, 20000] });
  assert.equal(cfg.delivery.smtp, null);
  assert.equal(cfg.rabbit.prefetch, 5);
});

test('constant backoff with multiplier 1', () => {
  assert.deepEqual(loadConfig({ ...base, NOTIFICATION_RETRY_BACKOFF_MULTIPLIER: '1' }).retry.delaysMs, [5000, 5000, 5000]);
});

test('SMTP settings are required only when the smtp channel is selected', () => {
  assert.throws(() => loadConfig({ ...base, NOTIFICATION_CHANNEL: 'smtp' }), (err) => {
    assert.ok(err instanceof ConfigError);
    assert.ok(err.problems.some((p) => p.startsWith('SMTP_HOST is required')));
    assert.ok(err.problems.some((p) => p.startsWith('SMTP_PORT is required')));
    return true;
  });
  const cfg = loadConfig({ ...base, NOTIFICATION_CHANNEL: 'smtp', SMTP_HOST: 'localhost', SMTP_PORT: '1025', SMTP_SECURE: 'false', SMTP_TIMEOUT_MS: '5000' });
  assert.deepEqual(cfg.delivery.smtp, { host: 'localhost', port: 1025, secure: false, user: undefined, password: undefined, timeoutMs: 5000 });
});

test('Clerk settings are required only for the clerk recipient source', () => {
  assert.throws(() => loadConfig({ ...base, NOTIFICATION_RECIPIENT_SOURCE: 'clerk' }), (err) =>
    err.problems.some((p) => p.startsWith('CLERK_SECRET_KEY is required')) && err.problems.some((p) => p.startsWith('NOTIFICATION_CLERK_API_URL is required')));
  const cfg = loadConfig({ ...base, NOTIFICATION_RECIPIENT_SOURCE: 'clerk', CLERK_SECRET_KEY: 'sk_test_x', NOTIFICATION_CLERK_API_URL: 'https://api.clerk.com/', NOTIFICATION_CLERK_TIMEOUT_MS: '3000' });
  assert.equal(cfg.recipients.clerkApiUrl, 'https://api.clerk.com');
});

test('ownership guard: the Mongo URI must name the worker\'s own database', () => {
  assert.throws(() => loadConfig({ ...base, NOTIFICATION_MONGO_URI: 'mongodb://root:x@localhost:27017/cart_db?authSource=admin' }), (err) =>
    err.problems.some((p) => p.includes('refusing to touch another database')));
});

test('lists every missing variable at once', () => {
  const { RABBITMQ_URL, NOTIFICATION_PREFETCH, ...rest } = base;
  assert.throws(() => loadConfig(rest), (err) => {
    assert.equal(err.problems.length, 2);
    assert.match(err.message, /RABBITMQ_URL is required/);
    assert.match(err.message, /NOTIFICATION_PREFETCH is required/);
    return true;
  });
});

test('rejects wildcard / spaced RabbitMQ names and duplicate names', () => {
  assert.throws(() => loadConfig({ ...base, RABBITMQ_NOTIFICATION_QUEUE: 'notification tasks' }), /must be a RabbitMQ name/);
  assert.throws(() => loadConfig({ ...base, RABBITMQ_NOTIFICATION_DLQ: 'notification.tasks' }), /must all be distinct/);
});
