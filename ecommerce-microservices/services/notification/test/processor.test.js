import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProcessor } from '../src/processor.js';
import { UnprocessableError } from '../src/lib/errors.js';
import { correlationIdOf, attemptOf } from '../src/rabbit/worker.js';
import { confirmationCommand, encode } from './helpers/fixtures.js';

const silent = { info() {}, warn() {}, error() {}, debug() {}, child() { return silent; } };
const config = { delivery: { from: 'OrderFlow <no-reply@orderflow.local>' } };

function fakeLedger(initial = {}) {
  const docs = new Map(Object.entries(initial));
  const calls = [];
  return {
    docs, calls,
    async claim(id) {
      calls.push(['claim', id]);
      const d = docs.get(id);
      if (!d) { docs.set(id, { status: 'sending' }); return { outcome: 'claimed' }; }
      if (d.status === 'sent') return { outcome: 'duplicate', sentAt: d.sentAt, instance: 'other' };
      return { outcome: 'in_flight', instance: 'other' };
    },
    async markSent(id, facts) { calls.push(['markSent', id]); docs.set(id, { status: 'sent', sentAt: new Date(), ...facts }); },
    async release(id) { calls.push(['release', id]); if (docs.get(id)?.status === 'sending') docs.delete(id); },
  };
}

function fakeChannel({ fail } = {}) {
  const sent = [];
  return {
    name: 'fake', sent,
    async send(envelope) { if (fail) throw fail; sent.push(envelope); return { providerMessageId: `fake-${sent.length}` }; },
  };
}

const recipients = { async resolve(userId) { return { to: 'orderflow-e2e@example.com', toName: `Customer ${userId}` }; } };
const props = { messageId: confirmationCommand().messageId, correlationId: 'req-abc-123', headers: {} };
const run = (p, content = encode(confirmationCommand()), attempt = 1) => p.process({ content, props, attempt, requestId: 'req-abc-123', log: silent });

test('happy path: claim → send → markSent, envelope carries the trace id and rendered rupees', async () => {
  const ledger = fakeLedger();
  const channel = fakeChannel();
  const result = await run(createProcessor({ config, channel, recipients, ledger }));
  assert.equal(result.kind, 'sent');
  assert.equal(result.template, 'order-confirmed');
  assert.equal(result.toMasked, 'o***@example.com');
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0].to, 'orderflow-e2e@example.com');
  assert.equal(channel.sent[0].meta.requestId, 'req-abc-123');
  assert.match(channel.sent[0].subject, /₹1,299\.00/);
  assert.deepEqual(ledger.calls.map((c) => c[0]), ['claim', 'markSent']);
  assert.equal(ledger.docs.get(props.messageId).status, 'sent');
});

test('idempotency: an already-sent messageId is a duplicate — nothing is sent', async () => {
  const ledger = fakeLedger({ [props.messageId]: { status: 'sent', sentAt: new Date('2026-09-21T00:00:00Z') } });
  const channel = fakeChannel();
  const result = await run(createProcessor({ config, channel, recipients, ledger }));
  assert.equal(result.kind, 'duplicate');
  assert.equal(channel.sent.length, 0);
  assert.deepEqual(ledger.calls.map((c) => c[0]), ['claim']);
});

test('a claim held by another live worker is a transient failure (re-checked after backoff), not a send', async () => {
  const ledger = fakeLedger({ [props.messageId]: { status: 'sending' } });
  const channel = fakeChannel();
  await assert.rejects(run(createProcessor({ config, channel, recipients, ledger })), (err) => !(err instanceof UnprocessableError) && /another worker/.test(err.message));
  assert.equal(channel.sent.length, 0);
});

test('malformed body → UnprocessableError before the ledger is touched', async () => {
  const ledger = fakeLedger();
  const channel = fakeChannel();
  await assert.rejects(run(createProcessor({ config, channel, recipients, ledger }), Buffer.from('{"nope":true}')), UnprocessableError);
  assert.equal(ledger.calls.length, 0);
  assert.equal(channel.sent.length, 0);
});

test('channel failure releases the claim so the retry can claim again, and rethrows (transient)', async () => {
  const ledger = fakeLedger();
  const channel = fakeChannel({ fail: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1025'), { code: 'ECONNREFUSED' }) });
  await assert.rejects(run(createProcessor({ config, channel, recipients, ledger })), /ECONNREFUSED/);
  assert.deepEqual(ledger.calls.map((c) => c[0]), ['claim', 'release']);
  assert.equal(ledger.docs.has(props.messageId), false, 'claim must be gone after a failure');
  // …and the retry succeeds once the channel is healthy again
  const healthy = fakeChannel();
  const result = await run(createProcessor({ config, channel: healthy, recipients, ledger }), undefined, 2);
  assert.equal(result.kind, 'sent');
  assert.equal(healthy.sent[0].meta.attempt, 2);
});

test('a vanished user (Clerk 404) is unprocessable — dead-letter, never retry', async () => {
  const ledger = fakeLedger();
  const gone = { async resolve() { throw new UnprocessableError('user_not_found', 'user gone'); } };
  await assert.rejects(run(createProcessor({ config, channel: fakeChannel(), recipients: gone, ledger })), UnprocessableError);
  assert.deepEqual(ledger.calls.map((c) => c[0]), ['claim', 'release']);
});

test('ledger write failure AFTER a successful send is acked (never a guaranteed duplicate)', async () => {
  const ledger = fakeLedger();
  ledger.markSent = async () => { throw new Error('mongo down'); };
  const channel = fakeChannel();
  const result = await run(createProcessor({ config, channel, recipients, ledger }));
  assert.equal(result.kind, 'sent');
  assert.equal(result.ledger, 'not-recorded');
  assert.equal(channel.sent.length, 1);
});

test('correlation id precedence: AMQP correlationId → X-Request-Id header → body → minted', () => {
  assert.deepEqual(correlationIdOf({ correlationId: 'from-props', headers: { 'X-Request-Id': 'from-header' } }, { correlationId: 'from-body' }), { requestId: 'from-props', minted: false });
  assert.deepEqual(correlationIdOf({ headers: { 'X-Request-Id': 'from-header' } }, { correlationId: 'from-body' }), { requestId: 'from-header', minted: false });
  assert.deepEqual(correlationIdOf({ headers: {} }, { correlationId: 'from-body' }), { requestId: 'from-body', minted: false });
  const minted = correlationIdOf({ correlationId: 'has spaces!' , headers: {} }, {});
  assert.equal(minted.minted, true);
  assert.match(minted.requestId, /^[0-9a-f-]{36}$/);
});

test('attempt header: absent → 1, numeric / string / Buffer forms accepted, garbage → 1', () => {
  assert.equal(attemptOf({ headers: {} }), 1);
  assert.equal(attemptOf({}), 1);
  assert.equal(attemptOf({ headers: { 'x-attempt': 3 } }), 3);
  assert.equal(attemptOf({ headers: { 'x-attempt': '4' } }), 4);
  assert.equal(attemptOf({ headers: { 'x-attempt': Buffer.from('2') } }), 2);
  assert.equal(attemptOf({ headers: { 'x-attempt': 'many' } }), 1);
  assert.equal(attemptOf({ headers: { 'x-attempt': 0 } }), 1);
});
