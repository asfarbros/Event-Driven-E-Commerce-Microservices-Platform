/**
 * Topology. Two parts:
 *
 * 1. STEP 6 OBJECTS (owned jointly with the Order Service; declared here with
 *    EXACTLY the same arguments as services/order/.../rabbit/RabbitTopology.java
 *    and infra/rabbitmq/declare-topology.sh, so the declaration is idempotent
 *    whichever side starts first — a differing argument would make RabbitMQ
 *    close the channel with PRECONDITION_FAILED):
 *
 *      exchange  <EXCHANGE>   topic, durable
 *         └─ order.*  ──►  queue <QUEUE>   durable, x-dead-letter-exchange = <DLX>
 *      exchange  <DLX>        topic, durable
 *         └─ #        ──►  queue <DLQ>     durable
 *
 * 2. WORKER-OWNED RETRY TIERS (new in Step 7). One queue per configured
 *    delay, named <RETRY_QUEUE>.<delay>ms:
 *
 *      queue <RETRY_QUEUE>.5000ms   durable, x-message-ttl = 5000,
 *                                   x-dead-letter-exchange = "" (default),
 *                                   x-dead-letter-routing-key = <QUEUE>
 *      queue <RETRY_QUEUE>.10000ms  …  (and so on, one per backoff step)
 *
 *    A failed message is published to the tier for its attempt and acked
 *    from the main queue; when the tier's TTL expires RabbitMQ dead-letters
 *    it straight back into <QUEUE> via the default exchange — no plugin, no
 *    timers in the worker, and nothing survives a worker crash except the
 *    broker's own state. One queue per delay (rather than per-message
 *    expiration on one queue) because RabbitMQ only expires from the HEAD of a
 *    queue: a 20 s message in front would hold back a 5 s one behind it.
 *    Putting the delay in the name means changing the backoff creates new
 *    queues instead of a PRECONDITION_FAILED on the old ones (stale empty tier
 *    queues are harmless and can be deleted in the management UI).
 */

/** The binding pattern Step 6 declared (RabbitTopology.java / declare-topology.sh). */
export const TASK_BINDING_PATTERN = 'order.*';
export const DLQ_BINDING_PATTERN = '#';

export function retryQueueName(retryQueue, delayMs) {
  return `${retryQueue}.${delayMs}ms`;
}

export async function assertTopology(ch, rabbit, retry) {
  await ch.assertExchange(rabbit.exchange, 'topic', { durable: true });
  await ch.assertExchange(rabbit.deadLetterExchange, 'topic', { durable: true });
  const main = await ch.assertQueue(rabbit.queue, { durable: true, deadLetterExchange: rabbit.deadLetterExchange });
  const dlq = await ch.assertQueue(rabbit.deadLetterQueue, { durable: true });
  await ch.bindQueue(rabbit.queue, rabbit.exchange, TASK_BINDING_PATTERN);
  await ch.bindQueue(rabbit.deadLetterQueue, rabbit.deadLetterExchange, DLQ_BINDING_PATTERN);

  const retryQueues = [];
  for (const delayMs of retry.delaysMs) {
    const name = retryQueueName(rabbit.retryQueue, delayMs);
    const q = await ch.assertQueue(name, {
      durable: true,
      messageTtl: delayMs,
      deadLetterExchange: '',
      deadLetterRoutingKey: rabbit.queue,
    });
    retryQueues.push({ name, delayMs, messageCount: q.messageCount });
  }

  return {
    exchange: rabbit.exchange,
    deadLetterExchange: rabbit.deadLetterExchange,
    queue: { name: rabbit.queue, messageCount: main.messageCount, consumerCount: main.consumerCount, deadLetterExchange: rabbit.deadLetterExchange },
    deadLetterQueue: { name: rabbit.deadLetterQueue, messageCount: dlq.messageCount },
    bindings: [`${rabbit.exchange} --(${TASK_BINDING_PATTERN})--> ${rabbit.queue}`, `${rabbit.deadLetterExchange} --(${DLQ_BINDING_PATTERN})--> ${rabbit.deadLetterQueue}`],
    retryQueues,
  };
}
