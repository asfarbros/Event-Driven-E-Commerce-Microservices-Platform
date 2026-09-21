# Notification Worker

A **headless background worker** — no public API, never called by the browser,
not routed through the API Gateway. It consumes notification **commands** from
RabbitMQ (`notification.tasks`, published by the Order Service) and delivers
them to the customer as e-mail: to the terminal (`console` channel, the
default for demos) or through SMTP (`smtp` channel, e.g. the Mailpit test
inbox). It is the final hop of the trace that starts at the Gateway.

Node.js 20 · `amqplib` 2 (the reference AMQP 0-9-1 client; its promise API is
unchanged since 0.10) · `zod` · `pino` · `nodemailer` · `mongoose` (for one
tiny collection) · `dotenv` reading the **root** `.env`.

```
services/notification
├── package.json
├── README.md
├── src
│   ├── index.js                 boot: .env → config → /health → ledger → RabbitMQ → signals
│   ├── processor.js             one command: validate → claim → resolve recipient → render → send → mark
│   ├── recipients.js            userId → e-mail (Clerk Backend API, cached, single-flight) or static
│   ├── health.js                GET /health, GET /ready (plain node:http)
│   ├── config/env.js            validates every env var at boot, lists all problems; DB-ownership guard
│   ├── rabbit/topology.js       Step 6 objects (identical declaration) + worker-owned retry tiers
│   ├── rabbit/worker.js         connect/reconnect with backoff, QoS, consume, ack / retry / dead-letter, drain
│   ├── validation/command.js    the zod contract for the command body
│   ├── templates/index.js       order-confirmed, order-cancelled, payment-failed (text + html)
│   ├── channels/index.js        channel selector (the pluggable interface)
│   ├── channels/console.js      boxed, readable rendering to stdout (default)
│   ├── channels/smtp.js         nodemailer pooled SMTP transport
│   ├── db/mongo.js              connection lifecycle (retry, no command buffering)
│   ├── db/dedupe.js             claim → send → markSent ledger, TTL retention
│   └── lib/{logger,money,errors,redact,metrics}.js
├── scripts
│   ├── publish-command.mjs      publish commands by hand (valid / malformed / duplicates / N at once)
│   ├── dlq.mjs                  list | replay [--message-id] | purge --yes
│   ├── queues.mjs               depths of main / retry tiers / DLQ (--watch)
│   ├── peek.mjs                 non-destructive look inside any queue
│   └── lib.mjs
└── test                         46 unit tests: money, contract, templates, processor, config
```

## Run it

```bash
cd services/notification
npm install
npm start                 # reads ../../.env; /health on NOTIFICATION_PORT (4003)
npm start | npx pino-pretty
npm test                  # 46 unit tests, no infrastructure needed

# a second instance (competing consumer) — only the health port must differ
NOTIFICATION_PORT=4013 NOTIFICATION_INSTANCE_ID=worker-B npm start

# publish commands without the Order Service
node scripts/publish-command.mjs                    # one order.confirmed
node scripts/publish-command.mjs --type payment-failed --request-id trace-1
node scripts/publish-command.mjs --count 20         # 20 distinct orders
node scripts/publish-command.mjs --message-id notify-x --twice   # dedupe test
node scripts/publish-command.mjs --malformed        # → DLQ immediately
node scripts/queues.mjs --watch                     # watch the retry cycle
node scripts/dlq.mjs list                           # what is parked, and why
```

Needs the Step 0 infrastructure (RabbitMQ, MongoDB) and, for
`NOTIFICATION_RECIPIENT_SOURCE=clerk`, network access to `api.clerk.com` with
the `CLERK_SECRET_KEY` from `.env`. With `static` it runs fully offline.

`GET /health` (internal only) reports: RabbitMQ state (`connected` /
`reconnecting` / …, reconnect attempt, last error), the consumer (tag, queue,
prefetch, in-flight), the topology it bound to, the retry schedule, the
ledger (Mongo state, retention), the channel, the recipient source, and the
counters `received / sent / duplicates / retried / deadLettered /
unprocessable / requeued / inFlight`. `GET /ready` is 200 only while consuming.
`status` is `ok`, `degraded` (reconnecting, or ledger down — deliveries are
retried, never sent un-deduplicated) or `unhealthy`.

## Why RabbitMQ here and Kafka everywhere else

The saga's messages are **events** — *"the order was confirmed"* — facts that
several independent consumer groups (Inventory, Payment, later analytics)
each read at their own pace and can replay from any offset. That is Kafka's
partitioned, durable log with per-group offsets.

A notification is a **command** — *"send this customer this one e-mail, once"*
— a unit of work that exactly one worker must perform and then account for.
That shape needs things a log does not give you:

| Need | Kafka | RabbitMQ (what this worker uses) |
| --- | --- | --- |
| Remove a message only when *this* one succeeded | offsets are per partition, not per message; one stuck record blocks the partition | **per-message ack** (`basic.ack` after delivery) |
| Retry one failing message later without touching the others | re-seek or re-publish yourself | **nack/republish** into a delayed queue; the rest keep flowing |
| Park a poison message where a human can look at it | write your own DLT producer | **dead-letter exchange** built into the queue definition |
| Share the queue between N workers, adding a worker = more throughput | consumers ≤ partitions; rebalances | **competing consumers**: `basic.qos` prefetch + round-robin dispatch |
| Keep history for replay | yes — the point of Kafka | no — a delivered command is gone, which is what you want |

So the Order Service publishes the *event* `OrderConfirmed` to Kafka (for
Inventory and Payment) **and** the *command* `SendOrderConfirmation` to
RabbitMQ (for exactly one delivery attempt chain here).

## Topology

Found from Step 6 (`services/order/.../rabbit/RabbitTopology.java`,
`infra/rabbitmq/declare-topology.sh`) and declared here with **identical
arguments** (idempotent — whichever side starts first wins, and a differing
argument would make RabbitMQ close the channel with `PRECONDITION_FAILED`,
which the worker reports as a clear "topology mismatch" error):

```
exchange  notifications         topic, durable
   └─ order.*  ──►  queue notification.tasks       durable, x-dead-letter-exchange = notifications.dlx
exchange  notifications.dlx     topic, durable
   └─ #        ──►  queue notification.tasks.dlq   durable
```

Added by this worker (owned by it) — one retry queue per backoff step:

```
queue notification.tasks.retry.5000ms    durable, x-message-ttl 5000,  DLX "" (default), DL routing key notification.tasks
queue notification.tasks.retry.10000ms   durable, x-message-ttl 10000, …
queue notification.tasks.retry.20000ms   durable, x-message-ttl 20000, …
```

Every name comes from `.env` (`RABBITMQ_NOTIFICATION_EXCHANGE`, `_QUEUE`,
`_DLX`, `_DLQ`, `_RETRY_QUEUE`); the tier suffix is the delay so that changing
the backoff creates new queues instead of failing on the old ones (stale empty
tiers can be deleted in the management UI). The worker consumes
`notification.tasks` with `basic.qos(NOTIFICATION_PREFETCH)` and manual acks.

## Message contract

Exactly what the Order Service publishes (`OutboxWriter.notification()`).
AMQP properties: `messageId` = body `messageId`, `correlationId` = the
Gateway's `X-Request-Id`, `type` = `commandType`, `contentType
application/json`, persistent; header `X-Request-Id`. Body, validated with
zod (`src/validation/command.js`) before anything else happens:

```json
{ "messageId": "notify-<orderId>-order.confirmed",          // stable — the dedupe key
  "commandType": "SendOrderConfirmation" | "SendOrderCancellation",
  "version": 1, "source": "order", "occurredAt": "ISO-8601", "correlationId": "…",
  "orderId": "<uuid>", "userId": "user_…", "status": "CONFIRMED" | "CANCELLED" | "FAILED",
  "totalInPaise": 129900, "currency": "INR", "reason": "… (cancellations only)",
  "items": [ { "productId", "sku", "name", "quantity", "unitPriceInPaise", "lineTotalInPaise" } ] }
```

Unknown extra fields are tolerated; `version` must be `1`; money must be a
non-negative integer (a float or a string is a schema violation); `items`
must be non-empty. The correlation id for logs is taken from the AMQP
`correlationId`, then the `X-Request-Id` header, then the body, and only
then minted — so a real checkout's `X-Request-Id` reaches this worker's logs.

Templates: `SendOrderConfirmation` → **order-confirmed**;
`SendOrderCancellation` with `status: "FAILED"` (Order marks an order FAILED
only when the payment failed) → **payment-failed**; any other cancellation →
**order-cancelled**. Money is rendered in exactly one place,
`src/lib/money.js` (`129900 → ₹1,299.00`, Indian grouping, exact integer
arithmetic), and unit-tested for 0, 1 paisa, lakh/crore values and bad input.

The recipient address is not in the command — users belong to Clerk — so the
worker resolves `userId` through the Clerk Backend API (`GET /v1/users/{id}`,
same secret the Gateway uses), caches it, and coalesces concurrent lookups
for one user into a single request. A 404 (user deleted) is *unprocessable*;
network errors are *transient*. `NOTIFICATION_RECIPIENT_SOURCE=static` sends
everything to `NOTIFICATION_STATIC_RECIPIENT` instead (offline demos, Mailpit).

## Reliability guarantees

**Unprocessable vs. transient** is the distinction everything rests on.
A message that fails validation, has an unknown command type, or names a user
that no longer exists can *never* succeed: retrying it only delays the next
message. It is dead-lettered **immediately** with `x-failure-kind:
unprocessable` and the zod problems in `x-failure-details`. Everything else
(SMTP refused, Clerk timeout, ledger unreachable) is transient and retried.

1. **Acknowledgement** — manual acks only. A delivery is acked after one of:
   the channel delivered it and the ledger recorded it; the ledger said it was
   already sent; a copy was published *and confirmed by the broker* to a retry
   tier; a copy was published and confirmed to the DLX. Never before the work.
   If the copy cannot be confirmed (connection lost) the original stays
   unacked and the broker redelivers it — nothing is lost.
2. **Prefetch** — `NOTIFICATION_PREFETCH` (5) bounds unacked deliveries per
   instance, so a second instance on the same queue actually gets work.
3. **Retry with backoff** — on a transient failure the message is republished
   to the retry tier for its attempt with `x-attempt` incremented (plus
   `x-last-error`, `x-first-failed-at`, `x-original-routing-key`) and the
   original is acked. The tier's TTL expires and RabbitMQ dead-letters the copy
   *back into the main queue* through the default exchange. No plugin, no
   in-process timers: a worker crash mid-backoff loses nothing. Schedule =
   `RABBITMQ_NOTIFICATION_RETRY_DELAY_MS × NOTIFICATION_RETRY_BACKOFF_MULTIPLIER^(k-1)`
   for retry *k* up to `RABBITMQ_NOTIFICATION_MAX_RETRIES` — with the defaults
   5 s, 10 s, 20 s; **4 attempts** in total. Observed: attempts at +0, +5.01 s,
   +10.01 s, +20.01 s → dead-lettered at +35.03 s.
4. **Dead letter** — after the last attempt (`x-failure-kind: exhausted`) or
   immediately for unprocessable messages, a copy carrying `x-failure-reason`,
   `x-failure-details`, `x-attempts`, `x-dead-lettered-at`,
   `x-dead-lettered-by` (instance), `x-original-queue` and
   `x-original-routing-key` is published to `notifications.dlx` and the
   original is acked. All original properties (messageId, correlationId, type)
   are preserved, so the DLQ is inspectable and replayable (below).
5. **Idempotency** — see *Deduplication* below.
6. **Connection resilience** — on connection or channel loss the worker goes
   `reconnecting` and retries with exponential backoff and jitter between
   `NOTIFICATION_RECONNECT_MIN_MS` and `_MAX_MS` (1 s → 30 s), then rebuilds
   the confirm channel, re-asserts the topology, re-applies QoS and re-opens
   the consumer. It never exits on a broker outage. Observed backoff:
   1.15 s, 1.97 s, 4.59 s, 8.73 s, 14.27 s, 25.45 s.
7. **Graceful shutdown** — on SIGTERM/SIGINT: `basic.cancel` (no new
   deliveries), wait for in-flight handlers (each ends with its own ack or
   confirmed republish), close channel and connection, then the SMTP pool, the
   ledger and `/health`; exit 0. Bounded by `NOTIFICATION_SHUTDOWN_TIMEOUT_MS`;
   anything still in flight at the deadline is left *unacked* so the broker
   redelivers it after restart (exit 1). A shutdown never loses or double-sends.

> Windows note: a SIGTERM sent from another process cannot reach a Node
> process on Windows (the OS terminates it). Ctrl-C in the terminal *is*
> delivered (SIGINT) and drains correctly; in Docker (Step 8) SIGTERM works
> normally. Verification 10 was run in a `node:20-alpine` container for that
> reason.

## Deduplication (the same messageId never sends two e-mails)

Both sources of duplicates are real: the Order Service's outbox relay is
at-least-once (a crash between publish and "mark published" republishes), and
RabbitMQ redelivers anything whose consumer died before acking. An in-memory
set forgets on restart — exactly when redelivery happens — and cannot be shared
by competing consumers. So the ledger is **durable and shared: MongoDB,
database `notification_db`, collection `sent_notifications`**, one document
per `messageId`. It is this worker's own database (`NOTIFICATION_MONGO_URI`
must name `NOTIFICATION_DB_NAME`, the same ownership guard as Catalog/Cart);
nothing else is stored.

Protocol, `src/db/dedupe.js`: **claim** (`insert {_id: messageId, status:
'sending'}`) → send → **markSent**. An existing `sent` document means
duplicate → acked without sending. An existing `sending` claim younger than
`NOTIFICATION_DEDUPE_CLAIM_TTL_MS` (60 s) means another instance is sending it
right now → treated as transient (re-checked after backoff); older means that
worker died mid-send → taken over. On failure the claim is released so the
retry can claim again.

Retention: `NOTIFICATION_DEDUPE_RETENTION_HOURS` (168 h = 7 days) via a TTL
index on `expiresAt`. **Trade-off:** this is at-least-once with a small
window — if the process dies *after* the SMTP server accepted the mail but
*before* `markSent` lands, the claim goes stale and the redelivery re-sends
once. Closing that window would need a transaction spanning SMTP and the
database, which does not exist; the alternative (mark before sending) risks
never sending a purchase confirmation, the worse failure. If the ledger write
fails after a successful send, the delivery is still acked (retrying would
*guarantee* a duplicate) and logged at error level. If the ledger is down
before sending, the message is retried, not sent un-deduplicated. Seven days
covers any realistic redelivery, outbox replay or manual DLQ replay; a replay
older than that would send again.

## Inspecting and replaying the DLQ

```bash
node scripts/dlq.mjs list          # every parked message: reason, details, attempts, when, which instance
node scripts/dlq.mjs replay        # all → back to `notifications` with the original routing key
node scripts/dlq.mjs replay --message-id notify-<orderId>-order.confirmed
node scripts/dlq.mjs purge --yes
```

Replay strips the worker's `x-failure-*` / `x-attempt` bookkeeping and
RabbitMQ's `x-death`, adds `x-replayed-at`, republishes with publisher
confirms and acks the DLQ copy only after the broker confirmed — a replay can
never lose a message. The attempt counter starts again. The ledger still
applies: a replayed message whose `messageId` was already sent is acked as a
duplicate. In the RabbitMQ management UI
(<http://localhost:15672> → Queues → `notification.tasks.dlq` → *Get messages*)
the same headers are visible; "Move messages" (shovel plugin) also works.

## Enabling real e-mail (SMTP / Mailpit)

Mailpit (`orderflow-mailpit`, `axllent/mailpit:v1.27.0`) is part of
`infra/docker-compose.yml`: it accepts any mail on SMTP `MAILPIT_SMTP_PORT`
(1025) and shows it at <http://localhost:8093> (`MAILPIT_UI_PORT`). Nothing
leaves the laptop.

```bash
docker compose --env-file .env -f infra/docker-compose.yml up -d mailpit
NOTIFICATION_CHANNEL=smtp npm start            # or set it in .env
```

`SMTP_HOST/PORT/SECURE/USER/PASSWORD/TIMEOUT_MS` default to Mailpit (no auth,
no TLS); any real provider's settings work in the same variables. Messages
carry `X-Request-Id`, `X-OrderFlow-Message-Id` and `X-OrderFlow-Order-Id`
headers for tracing. Stopping Mailpit is the easiest way to watch the retry
and dead-letter path for real (`docker stop orderflow-mailpit`).

Adding a channel (SMS, push): one file in `src/channels/` implementing
`{ name, send(envelope), verify?(), close?(), describe() }` and one enum
value in `config/env.js`; the consumer does not change. Recipient addresses
and message bodies are never logged at info level (`to` is masked as
`o***@example.com`; pino's redact list is the backstop).

## Environment variables

Shared (Step 0/6): `RABBITMQ_URL`, `RABBITMQ_NOTIFICATION_EXCHANGE`, `_QUEUE`,
`_DLX`, `_DLQ`, `_MAX_RETRIES` (3), `_RETRY_DELAY_MS` (5000), `NOTIFICATION_PORT`,
`CLERK_SECRET_KEY`, `LOG_LEVEL`, `NODE_ENV`.

New in Step 7 (`.env` / `.env.example`, grouped and commented):

| Variable | Purpose |
| --- | --- |
| `NOTIFICATION_DB_NAME`, `NOTIFICATION_MONGO_URI` | dedupe ledger (must agree — ownership guard) |
| `NOTIFICATION_MONGO_TIMEOUT_MS`, `NOTIFICATION_MONGO_RETRY_INTERVAL_MS` | ledger connection |
| `NOTIFICATION_DEDUPE_RETENTION_HOURS` (168), `NOTIFICATION_DEDUPE_CLAIM_TTL_MS` (60000) | retention, stale-claim takeover |
| `RABBITMQ_NOTIFICATION_RETRY_QUEUE` | base name of the retry tiers |
| `NOTIFICATION_RETRY_BACKOFF_MULTIPLIER` (2) | 5 s → 10 s → 20 s |
| `NOTIFICATION_PREFETCH` (5) | `basic.qos` per instance |
| `NOTIFICATION_HEARTBEAT_S`, `NOTIFICATION_RECONNECT_MIN_MS`, `NOTIFICATION_RECONNECT_MAX_MS` | outage detection + reconnect backoff |
| `NOTIFICATION_SHUTDOWN_TIMEOUT_MS` | drain grace period |
| `NOTIFICATION_CHANNEL` (`console` \| `smtp`), `NOTIFICATION_FROM` | delivery |
| `NOTIFICATION_CONSOLE_DELAY_MS` (0) | optional simulated latency for the console channel (demos only) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_TIMEOUT_MS` | only when `smtp` |
| `MAILPIT_SMTP_PORT`, `MAILPIT_UI_PORT` | the Mailpit container's host ports |
| `NOTIFICATION_RECIPIENT_SOURCE` (`clerk` \| `static`), `NOTIFICATION_STATIC_RECIPIENT` | where the address comes from |
| `NOTIFICATION_CLERK_API_URL`, `NOTIFICATION_CLERK_TIMEOUT_MS` (10000), `NOTIFICATION_RECIPIENT_CACHE_TTL_S` | Clerk lookup |
| `NOTIFICATION_INSTANCE_ID` (optional; default `<hostname>-<pid>`) | tells instances apart in logs, ledger and DLQ headers |

Missing or invalid variables are all listed at once and the worker refuses to
start; SMTP and Clerk variables are only required for the mode that uses them.
