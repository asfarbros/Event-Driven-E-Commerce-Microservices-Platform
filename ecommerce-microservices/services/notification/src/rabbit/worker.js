/**
 * The RabbitMQ worker: connection lifecycle + the consumer loop.
 *
 * ACKNOWLEDGEMENT. Manual acks only (noAck: false). A delivery is acked ONLY
 * after one of these has completed:
 *   sent          the channel delivered it and the ledger recorded it;
 *   duplicate     the ledger says this messageId was already sent;
 *   retried       a copy with x-attempt+1 was published (and confirmed by the
 *                 broker) to the retry tier for this attempt;
 *   dead-lettered a copy with the failure reason was published (confirmed)
 *                 to the DLX.
 * If the copy cannot be confirmed (connection lost), the original is left
 * unacked and the broker redelivers it — nothing is lost, and the ledger
 * absorbs the duplicate. If the connection dies mid-flight the ack fails; we
 * log `requeued` and the broker redelivers.
 *
 * PREFETCH. `basic.qos(prefetch)` bounds the unacked deliveries per consumer,
 * so N instances on one queue each hold at most `prefetch` messages and the
 * broker round-robins the rest — competing consumers.
 *
 * RESILIENCE. On connection/channel loss: state → reconnecting, exponential
 * backoff with jitter between reconnectMinMs and reconnectMaxMs, then a fresh
 * connection → confirm channel → topology → qos → consume. Never exits.
 *
 * SHUTDOWN. stop(): basic.cancel (no new deliveries), wait for in-flight
 * handlers (each ends with its own ack/publish), then close channel and
 * connection. Bounded by shutdownTimeoutMs; anything still in flight at the
 * deadline is left unacked so the broker redelivers it after restart.
 */
import amqp from 'amqplib';
import { randomUUID } from 'node:crypto';
import { assertTopology, retryQueueName } from './topology.js';
import { UnprocessableError, describeError } from '../lib/errors.js';
import { maskUrl } from '../lib/redact.js';

export const HEADER = Object.freeze({
  attempt: 'x-attempt',
  lastError: 'x-last-error',
  firstFailedAt: 'x-first-failed-at',
  originalRoutingKey: 'x-original-routing-key',
  failureKind: 'x-failure-kind',
  failureReason: 'x-failure-reason',
  failureDetails: 'x-failure-details',
  attempts: 'x-attempts',
  deadLetteredAt: 'x-dead-lettered-at',
  deadLetteredBy: 'x-dead-lettered-by',
  originalQueue: 'x-original-queue',
  requestId: 'X-Request-Id',
});

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** X-Request-Id for this delivery: AMQP correlationId → header → body → minted. */
export function correlationIdOf(props, body) {
  for (const candidate of [props.correlationId, props.headers?.[HEADER.requestId], body?.correlationId]) {
    if (typeof candidate === 'string' && REQUEST_ID_PATTERN.test(candidate)) return { requestId: candidate, minted: false };
  }
  return { requestId: randomUUID(), minted: true };
}

/** Header values arrive as strings, numbers or Buffers depending on the publisher. */
function headerString(v) {
  if (v === undefined || v === null) return undefined;
  return Buffer.isBuffer(v) ? v.toString('utf8') : String(v);
}

export function attemptOf(props) {
  const raw = Number(headerString(props.headers?.[HEADER.attempt]));
  return Number.isInteger(raw) && raw >= 1 ? raw : 1;
}

/** Copy the publisher's properties so retried / dead-lettered copies stay inspectable. */
function copyProps(props, extraHeaders) {
  const headers = { ...(props.headers || {}) };
  delete headers['x-death'];          // RabbitMQ recomputes its own bookkeeping on the next hop
  delete headers['x-first-death-exchange'];
  delete headers['x-first-death-queue'];
  delete headers['x-first-death-reason'];
  delete headers['x-last-death-exchange'];
  delete headers['x-last-death-queue'];
  delete headers['x-last-death-reason'];
  return {
    persistent: true,
    messageId: props.messageId,
    correlationId: props.correlationId,
    type: props.type,
    contentType: props.contentType || 'application/json',
    contentEncoding: props.contentEncoding,
    timestamp: props.timestamp,
    appId: props.appId,
    headers: { ...headers, ...extraHeaders },
  };
}

function jitter(ms) { return Math.round(ms * (0.8 + Math.random() * 0.4)); }

export function createWorker({ config, logger, processor, metrics, instance }) {
  const { rabbit, retry } = config;
  const log = logger.child({ component: 'rabbit', broker: maskUrl(rabbit.url) });

  let connection = null;
  let channel = null;
  let channelEpoch = 0;
  let consumerTag = null;
  let state = 'disconnected';        // disconnected | connecting | connected | reconnecting | stopping | stopped
  let stopping = false;
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let connectedAt = null;
  let lastError = null;
  let topology = null;
  const inFlight = new Set();

  // ---------------------------------------------------------------------------
  // Publishing helpers (confirm channel: resolve only when the broker acks)
  // ---------------------------------------------------------------------------
  function publishConfirmed(ch, exchange, routingKey, content, options) {
    return new Promise((resolve, reject) => {
      ch.publish(exchange, routingKey, content, options, (err) => (err ? reject(err) : resolve()));
    });
  }

  async function scheduleRetry(ch, msg, attempt, err, ctx) {
    const delayMs = retry.delaysMs[attempt - 1];
    const queue = retryQueueName(rabbit.retryQueue, delayMs);
    const nowIso = new Date().toISOString();
    const props = msg.properties;
    await publishConfirmed(ch, '', queue, msg.content, copyProps(props, {
      [HEADER.attempt]: attempt + 1,
      [HEADER.lastError]: describeError(err).message.slice(0, 500),
      [HEADER.firstFailedAt]: headerString(props.headers?.[HEADER.firstFailedAt]) || nowIso,
      [HEADER.originalRoutingKey]: headerString(props.headers?.[HEADER.originalRoutingKey]) || msg.fields.routingKey,
    }));
    metrics.inc('retried');
    ctx.log.warn(
      { attempt, maxAttempts: retry.maxAttempts, nextAttempt: attempt + 1, retryInMs: delayMs, retryQueue: queue, err: describeError(err) },
      `delivery failed — retry ${attempt} of ${retry.maxRetries} scheduled in ${delayMs} ms`,
    );
  }

  async function deadLetter(ch, msg, kind, err, attempt, ctx) {
    const props = msg.properties;
    const routingKey = headerString(props.headers?.[HEADER.originalRoutingKey]) || msg.fields.routingKey;
    const described = describeError(err);
    await publishConfirmed(ch, rabbit.deadLetterExchange, routingKey, msg.content, copyProps(props, {
      [HEADER.failureKind]: kind,
      [HEADER.failureReason]: `${described.code ? `${described.code}: ` : ''}${described.message}`.slice(0, 1000),
      ...(described.details ? { [HEADER.failureDetails]: JSON.stringify(described.details).slice(0, 4000) } : {}),
      [HEADER.attempts]: attempt,
      [HEADER.deadLetteredAt]: new Date().toISOString(),
      [HEADER.deadLetteredBy]: instance,
      [HEADER.originalQueue]: rabbit.queue,
      [HEADER.originalRoutingKey]: routingKey,
      [HEADER.attempt]: attempt,
    }));
    metrics.inc('deadLettered');
    if (kind === 'unprocessable') metrics.inc('unprocessable');
    ctx.log.error(
      { kind, attempts: attempt, deadLetterQueue: rabbit.deadLetterQueue, err: described },
      kind === 'unprocessable'
        ? 'message can never succeed — dead-lettered immediately (no retries)'
        : `all ${attempt} attempts failed — dead-lettered`,
    );
  }

  // ---------------------------------------------------------------------------
  // One delivery
  // ---------------------------------------------------------------------------
  async function handle(ch, epoch, msg) {
    const startedAt = process.hrtime.bigint();
    const props = msg.properties;
    const attempt = attemptOf(props);
    let body = null;
    try { body = JSON.parse(msg.content.toString('utf8')); } catch { /* validated properly by the processor */ }
    const { requestId, minted } = correlationIdOf(props, body);
    const ctx = {
      requestId, attempt,
      log: log.child({
        requestId, messageId: props.messageId || body?.messageId || null, orderId: body?.orderId || null,
        routingKey: headerString(props.headers?.[HEADER.originalRoutingKey]) || msg.fields.routingKey, redelivered: msg.fields.redelivered, attempt,
      }),
    };
    metrics.inc('received');
    ctx.log.debug({ correlationMinted: minted, commandType: props.type || body?.commandType || null }, 'command received');

    let disposition;
    try {
      const result = await processor.process({ content: msg.content, props, attempt, requestId, log: ctx.log });
      disposition = result.kind;
      if (result.kind === 'sent') {
        metrics.inc('sent');
        ctx.log.info(
          { template: result.template, channel: result.channel, toMasked: result.toMasked, userId: result.userId,
            providerMessageId: result.providerMessageId, durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6, ledger: result.ledger },
          `notification sent: ${result.template} to ${result.toMasked}`,
        );
      } else {
        metrics.inc('duplicates');
        ctx.log.info({ firstSentAt: result.sentAt, firstSentBy: result.instance }, 'duplicate command — already sent, acked without sending');
      }
    } catch (err) {
      try {
        if (err instanceof UnprocessableError) {
          await deadLetter(ch, msg, 'unprocessable', err, attempt, ctx);
          disposition = 'dead-lettered';
        } else if (attempt >= retry.maxAttempts) {
          await deadLetter(ch, msg, 'exhausted', err, attempt, ctx);
          disposition = 'dead-lettered';
        } else {
          await scheduleRetry(ch, msg, attempt, err, ctx);
          disposition = 'retried';
        }
      } catch (publishErr) {
        // Could not hand the message on (connection gone). Leave it UNACKED: the broker redelivers.
        metrics.inc('requeued');
        ctx.log.warn({ error: describeError(publishErr), original: describeError(err) }, 'could not publish retry/dead-letter copy — leaving delivery unacked for redelivery');
        return;
      }
    }

    if (epoch !== channelEpoch || !channel) {
      metrics.inc('requeued');
      ctx.log.warn({ disposition }, 'channel was replaced before ack — broker will redeliver');
      return;
    }
    try {
      ch.ack(msg);
      ctx.log.debug({ disposition }, 'acked');
    } catch (err) {
      metrics.inc('requeued');
      ctx.log.warn({ error: describeError(err), disposition }, 'ack failed (connection lost) — broker will redeliver');
    }
  }

  function onDelivery(ch, epoch) {
    return (msg) => {
      if (msg === null) {
        // basic.cancel from the broker (queue deleted / node down): recover.
        log.warn('consumer cancelled by the broker — reconnecting');
        consumerTag = null;
        teardown('consumer-cancelled');
        return;
      }
      metrics.begin();
      const p = handle(ch, epoch, msg)
        .catch((err) => log.error({ error: describeError(err) }, 'unexpected error in delivery handler'))
        .finally(() => { metrics.end(); inFlight.delete(p); });
      inFlight.add(p);
    };
  }

  // ---------------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------------
  async function open() {
    state = reconnectAttempt === 0 ? 'connecting' : 'reconnecting';
    const conn = await amqp.connect(rabbit.url, { heartbeat: rabbit.heartbeatSeconds, clientProperties: { connection_name: `notification-worker ${instance}` } });
    conn.on('error', (err) => { lastError = describeError(err); log.error({ error: lastError }, 'connection error'); });
    conn.on('close', (err) => {
      if (connection !== conn) return;
      log.warn({ reason: err ? describeError(err) : 'closed' }, 'connection closed');
      teardown('connection-closed');
    });
    connection = conn;

    const ch = await conn.createConfirmChannel();
    ch.on('error', (err) => { lastError = describeError(err); log.error({ error: lastError }, 'channel error'); });
    ch.on('close', () => { if (channel === ch) teardown('channel-closed'); });
    channel = ch;
    channelEpoch += 1;
    const epoch = channelEpoch;

    try {
      topology = await assertTopology(ch, rabbit, retry);
    } catch (err) {
      if (err.code === 406) {
        throw new Error(`topology mismatch: ${err.message.split('\n')[0]} — an object exists with different arguments than this worker (and the Order Service) declare; delete it in the management UI or align the RABBITMQ_NOTIFICATION_* values`);
      }
      throw err;
    }
    await ch.prefetch(rabbit.prefetch);
    const consumed = await ch.consume(rabbit.queue, onDelivery(ch, epoch), { noAck: false, consumerTag: `notification-${instance}-${epoch}` });
    consumerTag = consumed.consumerTag;
    state = 'connected';
    connectedAt = new Date();
    reconnectAttempt = 0;
    lastError = null;
    log.info(
      { queue: rabbit.queue, prefetch: rabbit.prefetch, consumerTag, topology, retryDelaysMs: retry.delaysMs, maxAttempts: retry.maxAttempts },
      `consuming ${rabbit.queue} (prefetch ${rabbit.prefetch}, ${topology.queue.messageCount} waiting, ${topology.queue.consumerCount + 1} consumer${topology.queue.consumerCount === 0 ? '' : 's'})`,
    );
  }

  function teardown(reason) {
    const hadConnection = connection !== null;
    channel = null;
    consumerTag = null;
    const conn = connection;
    connection = null;
    if (conn) { try { conn.close().catch(() => {}); } catch { /* already closed */ } }
    if (stopping) return;
    if (hadConnection || state === 'connected') log.warn({ reason, inFlight: inFlight.size }, 'lost RabbitMQ — will reconnect');
    scheduleReconnect();
  }

  function scheduleReconnect() {
    if (stopping || reconnectTimer) return;
    reconnectAttempt += 1;
    const delay = jitter(Math.min(rabbit.reconnectMaxMs, rabbit.reconnectMinMs * 2 ** (reconnectAttempt - 1)));
    state = 'reconnecting';
    log.warn({ attempt: reconnectAttempt, retryInMs: delay }, `reconnecting to RabbitMQ in ${delay} ms (attempt ${reconnectAttempt})`);
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      if (stopping) return;
      const attempts = reconnectAttempt;
      try {
        await open();
        log.info({ afterAttempts: attempts }, 'reconnected to RabbitMQ — consumer, QoS and topology restored');
      } catch (err) {
        lastError = describeError(err);
        log.error({ error: lastError, attempt: reconnectAttempt }, 'reconnect failed');
        teardown('reconnect-failed');
      }
    }, delay);
  }

  async function start() {
    try {
      await open();
    } catch (err) {
      lastError = describeError(err);
      log.error({ error: lastError }, 'RabbitMQ unreachable at boot — will keep trying');
      teardown('boot-failed');
    }
  }

  async function stop(reason = 'shutdown') {
    if (stopping) return;
    stopping = true;
    state = 'stopping';
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    const ch = channel;
    if (ch && consumerTag) {
      try { await ch.cancel(consumerTag); log.info({ reason, inFlight: inFlight.size }, 'stopped consuming — draining in-flight deliveries'); }
      catch (err) { log.warn({ error: describeError(err) }, 'cancel failed (connection already gone)'); }
    }
    const deadline = new Promise((resolve) => setTimeout(() => resolve('timeout'), config.shutdownTimeoutMs).unref());
    const drained = await Promise.race([Promise.allSettled([...inFlight]).then(() => 'drained'), deadline]);
    if (drained === 'timeout') log.warn({ inFlight: inFlight.size }, 'grace period elapsed — remaining deliveries left unacked for redelivery');
    else log.info('all in-flight deliveries settled');
    try { if (ch) await ch.close(); } catch { /* already closed */ }
    try { if (connection) await connection.close(); } catch { /* already closed */ }
    channel = null; connection = null; consumerTag = null;
    state = 'stopped';
    log.info('RabbitMQ connection closed');
    return drained === 'drained' ? 0 : 1;
  }

  function describe() {
    return {
      state,
      connected: state === 'connected',
      broker: maskUrl(rabbit.url),
      connectedAt: connectedAt?.toISOString() ?? null,
      reconnectAttempt,
      lastError,
      consumer: { active: Boolean(consumerTag), consumerTag, queue: rabbit.queue, prefetch: rabbit.prefetch, inFlight: inFlight.size },
      topology: topology ? { exchange: topology.exchange, deadLetterExchange: topology.deadLetterExchange, deadLetterQueue: topology.deadLetterQueue.name, retryQueues: topology.retryQueues.map((q) => q.name), bindings: topology.bindings } : null,
      retry: { maxAttempts: retry.maxAttempts, delaysMs: retry.delaysMs },
    };
  }

  return { start, stop, describe };
}
