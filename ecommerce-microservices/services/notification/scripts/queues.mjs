#!/usr/bin/env node
/**
 * Queue depths for the whole notification topology (main, retry tiers, DLQ)
 * (exact, via AMQP passive declares). Handy while watching a retry cycle:
 *
 *   node scripts/queues.mjs            once
 *   node scripts/queues.mjs --watch    every second until Ctrl-C
 */
import { env, queueDepths, has } from './lib.mjs';
import { retryQueueName } from '../src/rabbit/topology.js';

const { config } = env();
const names = [config.rabbit.queue, ...config.retry.delaysMs.map((d) => retryQueueName(config.rabbit.retryQueue, d)), config.rabbit.deadLetterQueue];

async function show() {
  const rows = await queueDepths(config, names);
  const stamp = new Date().toISOString().slice(11, 23);
  console.log(`${stamp}  ${rows.map((r) => (r.error ? `${r.queue}: ${r.error}` : `${r.queue}=${r.ready}${r.consumers ? ` (${r.consumers} consumer${r.consumers === 1 ? '' : 's'})` : ''}`)).join('   ')}`);
}

await show();
if (has('--watch')) setInterval(show, 1000);
