/**
 * Shared bits for the operational scripts: root .env + AMQP connection +
 * RabbitMQ management API (queue depths, DLQ peeking). Run from anywhere;
 * every name/credential comes from the root .env.
 */
import amqp from 'amqplib';
import { loadDotenv, loadConfig } from '../src/config/env.js';

export function env() {
  loadDotenv();
  const config = loadConfig();
  const mgmtPort = process.env.RABBITMQ_MANAGEMENT_PORT;
  const user = process.env.RABBITMQ_USER;
  const password = process.env.RABBITMQ_PASSWORD;
  const vhost = process.env.RABBITMQ_VHOST || '/';
  if (!mgmtPort || !user || !password) throw new Error('RABBITMQ_MANAGEMENT_PORT / RABBITMQ_USER / RABBITMQ_PASSWORD must be set in .env');
  return { config, mgmt: { base: `http://localhost:${mgmtPort}/api`, auth: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`, vhost: encodeURIComponent(vhost) } };
}

export async function mgmtGet(mgmt, path) {
  const res = await fetch(`${mgmt.base}/${path}`, { headers: { Authorization: mgmt.auth } });
  if (!res.ok) throw new Error(`management API ${path} → HTTP ${res.status}`);
  return res.json();
}

/**
 * Exact depths via AMQP queue.declare(passive) — the management API's
 * per-queue counters are sampled and can lag by several seconds.
 */
export async function queueDepths(config, names) {
  return withChannel(config, async (ch) => {
    const out = [];
    for (const name of names) {
      try {
        const q = await ch.checkQueue(name);
        out.push({ queue: name, ready: q.messageCount, consumers: q.consumerCount });
      } catch (err) {
        out.push({ queue: name, error: err.message.split('\n')[0] });
      }
    }
    return out;
  });
}

export async function withChannel(config, fn) {
  const conn = await amqp.connect(config.rabbit.url);
  const ch = await conn.createConfirmChannel();
  try {
    return await fn(ch);
  } finally {
    await ch.close().catch(() => {});
    await conn.close().catch(() => {});
  }
}

export function publishConfirmed(ch, exchange, routingKey, content, options) {
  return new Promise((resolve, reject) => ch.publish(exchange, routingKey, content, options, (err) => (err ? reject(err) : resolve())));
}

export function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

export const has = (name) => process.argv.includes(name);
