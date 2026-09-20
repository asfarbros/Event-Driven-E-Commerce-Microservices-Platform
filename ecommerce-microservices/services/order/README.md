# Order Service

The orchestrator. It owns the order lifecycle and coordinates checkout across
Cart, Catalog, Inventory and Payment — synchronously while the customer waits,
then by reacting to Kafka events after they have gone. It is the only service
that knows the full story of an order, and it owns **`order_db`** and nothing
else: every fact about other services' data comes over their REST APIs or
their events, never their databases.

Stack: **Java 17 · Spring Boot 3.5 · Spring Web · Spring Data JPA · PostgreSQL ·
Flyway · spring-kafka · Spring AMQP (RabbitMQ) · Resilience4j · Bean Validation ·
Actuator · logstash-logback-encoder**. Same conventions as
[`inventory`](../inventory/README.md) and [`payment`](../payment/README.md):
root `.env` loading, fail-fast `ConfigGuard` with the database-ownership
guard, JSON logs, `{ error, message, requestId }` errors, `X-Request-Id`
correlation, explicit transaction boundaries, graceful shutdown. No Lombok.

---

## The India checkout flow: a synchronous zone and an asynchronous zone

Indian regulation requires two-factor authentication on digital payments — the
customer must be present to enter an OTP or UPI PIN. So checkout splits:

**SYNCHRONOUS ZONE — `POST /orders`, the user is waiting** (`service/CheckoutService`)

```
 1  X-User-Id from the gateway (401 if absent — never a client-supplied id)
 2  Cart   GET /snapshot            strict priced cart; fails rather than degrades
 3  Catalog POST /products/prices   FRESH prices → WE compute the total (integer paise)
 4  INSERT order PENDING + immutable line snapshot + OrderCreated in the outbox      [one transaction]
 5  Inventory POST /reserve         stock BEFORE money → RESERVED (or FAILED + 409 naming the short products)
 6  Payment  POST /payments         our amount → AWAITING_PAYMENT, razorpayOrderId recorded
 7  Cart DELETE /  (best effort); respond with orderId + what the browser needs for the Razorpay widget
```
The user then completes 2FA directly with Razorpay. We are not involved.

**ASYNCHRONOUS ZONE — the user has left** (`kafka/SagaEventsListener`, `service/OrderService`)

```
 8  payment-events  PaymentSucceeded  → CONFIRMED  → order-events OrderConfirmed (Inventory converts the hold; Payment ignores it)
                                                   → RabbitMQ command SendOrderConfirmation
 9  payment-events  PaymentFailed     → FAILED     → order-events OrderCancelled (Inventory releases the hold)
10  inventory-events InventoryReleased(EXPIRED) on an unpaid order → CANCELLED → OrderCancelled
    inventory-events InventoryConfirmFailed (paid after the hold died)  → CANCELLED + refund
    payment-events  PaymentRefunded   → paymentStatus REFUNDED
```

### Price changes between viewing the cart and checking out

Step 3 re-fetches prices from Catalog and recomputes the total; the cart's
numbers are never trusted (nor is anything from the browser — the request body
carries no prices or amounts at all). If a fresh price differs from the cart's
snapshot, `ORDER_PRICE_CHANGE_POLICY` decides:

- `proceed` (default): charge the fresh price and return `priceChanges[]` in the
  response so the UI can tell the customer. Chosen as default because the cart
  already shows live prices, the window is seconds, and a hard rejection for a
  paisa-level change is a worse experience than an honest notice.
- `reject`: answer `409 price_changed` with the changes so the customer reviews
  the cart first — the right choice for a storefront with volatile pricing.

The snapshot stored in `order_item` (product, sku, name, unit price, line total)
is immutable history: there is no update path for it, and later Catalog
changes never touch a placed order.

---

## Run it

```bash
bash infra/kafka/create-topics.sh           # once, from the project root (adds payment-events.order.dlt, inventory-events.order.dlt)
bash infra/rabbitmq/declare-topology.sh     # once (the service also declares the same topology on start-up)

cd services/order
./mvnw clean package                        # → target/order-service.jar, runs 11 unit tests
java -jar target/order-service.jar          # ORDER_PORT (8081), reads ../../.env
./mvnw test -Pit                            # 3 concurrency/idempotency tests against the real order_db (fake downstream clients)
```

Needs JDK 17, PostgreSQL (`order_db`), Kafka (topics created), RabbitMQ, and —
for real checkouts — Catalog, Cart, Inventory and Payment running on their
`*_SERVICE_URL`s. Through the gateway every route is under `/api/orders` and
needs a Clerk token.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `ORDER_PORT`, `ORDER_DB_URL/USER/PASSWORD/NAME`, `ORDER_DB_POOL_SIZE`, `ORDER_LOCK_TIMEOUT_MS`, `ORDER_SHUTDOWN_TIMEOUT_MS` | As in the other Java services; the URL must name `ORDER_DB_NAME` |
| `ORDER_PRICE_CHANGE_POLICY` | `proceed` \| `reject` (above) |
| `ORDER_PAGE_LIMIT_DEFAULT`, `ORDER_PAGE_LIMIT_MAX` | `GET /orders` paging |
| `CART_SERVICE_URL`, `CATALOG_SERVICE_URL`, `INVENTORY_SERVICE_URL`, `PAYMENT_SERVICE_URL` | Called directly, never via the gateway |
| `ORDER_CART_TIMEOUT_MS`, `ORDER_CATALOG_TIMEOUT_MS`, `ORDER_INVENTORY_TIMEOUT_MS`, `ORDER_PAYMENT_TIMEOUT_MS` | Per-dependency connect+read timeouts |
| `ORDER_BREAKER_FAILURE_RATE_THRESHOLD`, `_SLIDING_WINDOW_SIZE`, `_MINIMUM_CALLS`, `_WAIT_OPEN_MS`, `_HALF_OPEN_CALLS` | Circuit-breaker settings shared by the four per-dependency breakers |
| `ORDER_OUTBOX_RELAY_INTERVAL_MS`, `ORDER_OUTBOX_BATCH_SIZE` | Transactional outbox relay |
| `ORDER_RECONCILE_INTERVAL_MS`, `ORDER_RECONCILE_AFTER_MS`, `ORDER_ABANDON_AFTER_MS`, `ORDER_RECONCILE_BATCH_SIZE` | Reconciliation job |
| `KAFKA_BOOTSTRAP_SERVERS`, `KAFKA_TOPIC_ORDER_EVENTS`, `KAFKA_TOPIC_PAYMENT_EVENTS`, `KAFKA_TOPIC_INVENTORY_EVENTS`, `KAFKA_TOPIC_PAYMENT_EVENTS_ORDER_DLT`, `KAFKA_TOPIC_INVENTORY_EVENTS_ORDER_DLT` | Published topic, consumed topics, this consumer's dead-letter topics |
| `ORDER_KAFKA_CONSUMER_GROUP`, `ORDER_KAFKA_RETRY_{MAX_ATTEMPTS,INITIAL_MS,MULTIPLIER,MAX_MS}` | Consumer group and retry/backoff before dead-lettering |
| `RABBITMQ_URL`, `RABBITMQ_NOTIFICATION_EXCHANGE`, `RABBITMQ_NOTIFICATION_QUEUE`, `RABBITMQ_NOTIFICATION_DLX`, `RABBITMQ_NOTIFICATION_DLQ`, `ORDER_RABBITMQ_CONFIRM_TIMEOUT_MS` | Notification topology and publisher-confirm wait |
| `LOG_LEVEL` | Level for `com.orderflow.order` |

---

## Schema (Flyway `V1__orders_history_inbox_outbox.sql`)

```
orders                                  order_item (immutable snapshot)         order_status_history
──────                                  ──────────                              ────────────────────
id UUID PK                              id BIGSERIAL PK                         id BIGSERIAL PK
user_id                                 order_id → orders (CASCADE)             order_id → orders
status (CHECK: 6 states)                product_id, sku, name                   from_status, to_status
payment_status (CHECK: 4 states)        quantity > 0                            trigger CHECKOUT|PAYMENT_EVENT|INVENTORY_EVENT|USER|RECONCILIATION
total_in_paise BIGINT > 0               unit_price_in_paise ≥ 0                 reason, event_id, request_id, created_at
currency ~ ^[A-Z]{3}$                   line_total_in_paise = unit × qty (CHECK)
item_count, total_quantity > 0          UNIQUE (order_id, product_id)
reservation_id, reservation_expires_at
payment_id, razorpay_order_id, razorpay_key_id     processed_event (INBOX)          outbox_event (OUTBOX)
idempotency_key, idempotency_fingerprint           event_id PK                       id UUID PK, order_id
failure_reason, created_by_request_id              topic, event_type, order_id       destination KAFKA|RABBITMQ, target, routing_key
version, created_at, updated_at                    outcome, processed_at             event_type, message_id UNIQUE, payload JSONB
UNIQUE (user_id, idempotency_key)                                                    correlation_id, attempts, last_error, created_at, published_at
CHECK: CONFIRMED ⇒ payment_status ≠ UNPAID
```

| Index | Serves |
| --- | --- |
| `orders_user_created_idx (user_id, created_at DESC)` | `GET /orders` — rows come back already in output order |
| `orders_awaiting_payment_idx (updated_at) WHERE status = 'AWAITING_PAYMENT'` (**partial**) | the reconciliation scan; rows leave it on any terminal transition |
| `orders_user_idempotency_unique` | the `Idempotency-Key` replay lookup **and** the duplicate-checkout guarantee |
| `order_item_product_unique (order_id, product_id)` | loading an order's lines |
| `history_order_created_idx (order_id, created_at, id)` | "the full lifecycle of order X, in order" |
| `processed_event_pkey (event_id)` | the duplicate-event guard |
| `outbox_unpublished_idx (created_at) WHERE published_at IS NULL` (**partial**) | the relay's sweep; never scans published history |
| `outbox_order_idx (order_id, created_at)` | "every message this order produced" |
| `outbox_message_id_unique` | one notification command per (order, reason) |

---

## The order state machine (`domain/OrderStatus`, `Order.transitionTo`)

```
                     ┌──────────── (stock short / dependency down) ─────────────┐
                     │                                                          ▼
  PENDING ──► RESERVED ──► AWAITING_PAYMENT ──► CONFIRMED                    FAILED (terminal)
     │            │              │   │   │           │
     └─ FAILED    └─ FAILED      │   │   └─ FAILED   (PaymentFailed)
                                 │   └───── CANCELLED (user / hold expired / abandoned)
                                 └───────── CONFIRMED (PaymentSucceeded)
                                                     └── CANCELLED (user cancel → refund; InventoryConfirmFailed → refund)
```
`payment_status` (UNPAID → PAID → REFUND_PENDING → REFUNDED) is tracked
separately from fulfilment.

- **Explicit arrows only.** `OrderStatus.ALLOWED` is the single source of truth;
  `Order.transitionTo` throws `IllegalTransitionException` for anything else, and
  nothing in the service assigns a status directly.
- **Idempotent.** A transition to the current status returns `false` and writes
  nothing; applying `CONFIRMED` twice leaves one history row and no second
  outbox row.
- **Terminal states are final.** Nothing leaves FAILED or CANCELLED. A late or
  out-of-order event that would (e.g. `PaymentFailed` after CONFIRMED) is
  recorded as `IGNORED_STALE` in `processed_event` and as a history note — never
  applied. `PaymentSucceeded` landing on a FAILED/CANCELLED order does not
  resurrect it: the money is handed back by queueing `OrderCancelled` (Payment
  refunds), with `payment_status = REFUND_PENDING`.
- **Not-yet-ready events** (`PaymentSucceeded` before `AWAITING_PAYMENT` is
  committed) throw `OrderNotReadyException` → Kafka retries with backoff.
  **Unknown orders** throw `UnknownOrderException` → retried, then parked on
  that topic's DLT — logged, never crashed on, never invented.
- **Audit trail.** Every transition (and every stale/notable non-transition)
  appends to `order_status_history` in the same transaction, with the trigger,
  reason, causing `eventId` and `requestId`.

---

## Idempotency — three separate concerns

| Concern | Mechanism | Database constraint |
| --- | --- | --- |
| **Duplicate checkout** (double-click "Pay") | Client sends `Idempotency-Key` (8–128 chars). Same key + same body → the original order, `200`, `created: false`, whatever state it has reached. Same key + **different body** → `422 idempotency_key_conflict` (a SHA-256 fingerprint of user + body is stored with the key). No key → no deduplication (documented; the UI must send one). | `orders_user_idempotency_unique (user_id, idempotency_key)` — a losing concurrent insert rolls back and returns the winner. Verified: 30 concurrent checkouts → 1 order, 1 reserve call, 1 payment call. |
| **Duplicate events** (Kafka redelivery) | `processed_event` looked up first; the row is inserted in the SAME transaction as the transition and the outbox rows, so a redelivery finds it and stops. The state machine is the second guard. | `processed_event_pkey (event_id)`. Verified: same `PaymentSucceeded` ×3 → 1 processed row, 1 `OrderConfirmed`, 1 notification; 30 concurrent → 1 APPLIED / 29 DUPLICATE. |
| **Duplicate notifications** | The RabbitMQ command's `messageId` is deterministic — `notify-<orderId>-<routingKey>` — and stored in the outbox; a second decision to notify for the same reason is collapsed. The consumer (Step 7) deduplicates on `messageId` too. | `outbox_message_id_unique`. |

---

## Downstream calls and circuit breakers (`clients/`)

Every dependency has its own Resilience4j breaker (named `cart`, `catalog`,
`inventory`, `payment`), its own timeout, and `X-Request-Id` on every call.
4xx answers (`Rejected`: cart empty, stock short, validation) are business
outcomes and do **not** count as failures; timeouts, connection failures and
5xx (`Unavailable`) do. Breaker state is on `/health`; transitions are logged.

| Dependency | Timeout | Breaker fallback (what the caller gets) | Why |
| --- | --- | --- | --- |
| Cart | 3 s | `503 cart_unavailable`, **no order created** | you cannot invent a cart; the customer retries |
| Catalog | 3 s | `503 pricing_unavailable`, **no order created** | never charge a stale or guessed price |
| Inventory | 5 s | order → FAILED, `503 inventory_unavailable`, Payment **not** called; `OrderCancelled` queued in case a hold was taken by a request whose reply was lost | no money before stock |
| Payment | 10 s | inventory hold **released** (sync call + `OrderCancelled` in the outbox as the durable backstop), order → FAILED, `503 payment_unavailable` | never leave stock held with no path to payment |

Observed (`ORDER_BREAKER_*`: 50 % over a window of 10, min 4 calls, 10 s open, 2 half-open trials):

| Dependency | Failure mode used | Calls while failing | Open → fast fail | Recovery |
| --- | --- | --- | --- | --- |
| cart | process killed (connection refused) | 13–21 ms | OPEN after the 4th failure; next call 14 ms | HALF_OPEN after 10 s → CLOSED on the first successful checkout (2 cart calls) |
| catalog | unroutable address (connect timeout) | **3.24–3.53 s** each | OPEN after the 4th; next calls **0.22–0.25 s** (only the cart call runs) | — (restored by config) |
| inventory | process killed | 48–59 ms | OPEN after the 4th; orders FAILED cleanly with no hold | HALF_OPEN → CLOSED on the 2nd good reserve |
| payment | process killed | 0.31–0.37 s (cart+catalog+reserve+release) | OPEN; hold released each time | HALF_OPEN → CLOSED on the 2nd good call |

---

## Failure handling and compensation (the synchronous zone)

| Failure point | Already done | Compensation | Terminal state |
| --- | --- | --- | --- |
| Cart empty / unavailable | nothing | none needed | no order |
| Product gone / Catalog unavailable | nothing | none needed | no order |
| Inventory: stock short | order PENDING | none needed (nothing held); Payment never called | FAILED, 409 names the products and shortfalls |
| Inventory: unavailable / timeout | order PENDING | `OrderCancelled` queued (releases a hold whose reply was lost — Inventory is idempotent on orderId) | FAILED, 503 |
| Payment: unavailable / rejected / amount mismatch | hold taken | Inventory `/release` **now** + `OrderCancelled` in the outbox (durable backstop) | FAILED, 503/502 |
| Cart clear fails | everything | nothing — logged; the cart is no longer a source of truth | AWAITING_PAYMENT |
| User never pays | hold + Razorpay order | nothing active. Inventory's sweeper expires the hold → `InventoryReleased(EXPIRED)` → CANCELLED. Payment's reconciliation fails the payment → `PaymentFailed` → FAILED. If neither event ever arrives, **`OrderReconciliationJob`** resolves it (below). | CANCELLED / FAILED |
| Paid, but Inventory could not confirm the hold (`InventoryConfirmFailed`) | money taken, stock released | CANCELLED + `OrderCancelled` → Payment refunds | CANCELLED, REFUND_PENDING → REFUNDED |
| Payment lands on a FAILED/CANCELLED order | money taken | `OrderCancelled` → Payment refunds | unchanged, REFUND_PENDING → REFUNDED |

Invariant: an order is never left with money taken and stock released without
a refund in flight, nor with stock held and no path to resolution.

### Reconciliation job (`service/OrderReconciliationJob`)

Every `ORDER_RECONCILE_INTERVAL_MS`, orders unchanged in AWAITING_PAYMENT for
`ORDER_RECONCILE_AFTER_MS` are checked against Payment Service (`GET
/payments/{orderId}`): SUCCESS → CONFIRMED (+ `OrderConfirmed`, notification);
FAILED → FAILED (+ `OrderCancelled`); still unpaid after
`ORDER_ABANDON_AFTER_MS` → CANCELLED "abandoned" (+ `OrderCancelled`). Why it
is needed even though webhooks exist: webhooks reach *Payment*; this service
only learns through Kafka, and a record can be missing (Payment outage before
its publish), dead-lettered here, or older than retention when this service
was down. Rows are locked `FOR UPDATE SKIP LOCKED` one at a time, so an event
arriving at the same moment cannot double-apply.

---

## The dual-write problem: transactional outbox (`outbox/`)

"Commit the order as CONFIRMED" and "publish `OrderConfirmed`" are two systems
with no shared transaction. Publish first and the commit may fail (event
without state); commit first and the process may die before publishing
(state without event — Inventory keeps the hold forever). So every state
change writes its messages into `outbox_event` **in the same database
transaction** (`OutboxWriter`), and `OutboxRelay` publishes unpublished rows
afterwards — Kafka with `acks=all` awaited synchronously, RabbitMQ with
publisher confirms awaited synchronously — then sets `published_at`. Two
triggers: an after-commit nudge (milliseconds on the normal path, on the
relay's own thread and its own `REQUIRES_NEW` transaction) and a scheduled
sweep every `ORDER_OUTBOX_RELAY_INTERVAL_MS` (the safety net). Rows are
locked `FOR UPDATE SKIP LOCKED`, so overlapping runs or several instances
never send a row concurrently.

**Guarantee: at-least-once, in order per order, never lost.**
- *Never lost*: a row exists iff its state change committed; it is retried
  (`attempts`, `last_error`) until the broker confirms it. Broker down → rows
  accumulate (visible as `outbox.pending` on `/health`) and drain later; the
  HTTP path never blocks on a broker.
- *Duplicates are possible*: if the process dies after the broker accepted the
  message but before `published_at` was written, the row is sent again. Every
  message carries a stable id (`eventId` / `messageId`), and every consumer
  deduplicates — Inventory by reservation status, Payment by
  `refund_payment_unique`, this service by `processed_event`, the notification
  worker by `messageId`.
- *Verified* (crash test): Kafka paused → user cancel committed (2 outbox rows,
  unpublished) → JVM killed with `taskkill /F` → Kafka unpaused → restart →
  relay published both rows once. The topic showed **two** `OrderCancelled`
  records with the **same `eventId`**: the pre-crash producer had already
  pushed the bytes into the paused broker's socket and never got the ack.
  Inventory logged "already terminal, nothing changed" and Payment
  `NOTHING_TO_REFUND` for the second — exactly the at-least-once + idempotent-
  consumer contract.

---

## Endpoints

The gateway strips `/api/orders` and injects `X-User-Id` after verifying the
Clerk session; that header is the only accepted identity (`web/RequireUser`).

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/` | Checkout. Headers: `Idempotency-Key` (recommended), body `{ note? }`. **201** `{ orderId, status: AWAITING_PAYMENT, created: true, totalInPaise, currency, items[], reservation { reservationId, expiresAt }, payment { paymentId, razorpayOrderId, razorpayKeyId, amountInPaise, currency }, priceChanges?, requestId }`; **200** with `created: false` on a replay. Errors: `409 cart_empty` / `cart_has_unavailable_items` / `product_unavailable` / `price_changed` / `insufficient_stock` (with `details[{ productId, requested, available, shortBy }]`), `422 idempotency_key_conflict`, `503 cart_unavailable` / `pricing_unavailable` / `inventory_unavailable` / `payment_unavailable`, `502 payment_rejected`. |
| `GET` | `/` | The caller's orders, newest first: `?page=1&limit=20` → `{ items[], pagination { page, limit, total, totalPages, hasNext, hasPrev } }`. |
| `GET` | `/{orderId}` | Full detail: lines, reservation, payment, `paymentStatus`, `failureReason`, `history[]`. **Another user's order → 404** (same body as a non-existent id, so ids cannot be probed). |
| `GET` | `/{orderId}/status` | `{ orderId, status, paymentStatus, updatedAt }` for polling. |
| `POST` | `/{orderId}/cancel` | `{ reason? }`. AWAITING_PAYMENT → CANCELLED (hold released); CONFIRMED → CANCELLED + refund via `OrderCancelled`; terminal → `cancelled: false`; PENDING/RESERVED → `409 cancel_not_allowed`. |
| `GET` | `/health`, `/ready` | db, kafka (5 topics), rabbitmq (queue depths), the four breakers, outbox (`pending`), reconciliation. `/ready` = db ∧ kafka ∧ rabbitmq. |

All errors: `{ error, message, requestId[, details] }`; no stack traces, SQL or
downstream internals.

---

## Kafka

### Publishes `order-events` — conforms to what Inventory and Payment consume

Both consumers documented the envelope they read — `{ eventType, version,
eventId, orderId, occurredAt }` with the `X-Request-Id` header, key = orderId —
and both ignore unknown fields. This service emits exactly those names and
types plus informational extras (`OutboxContractTest` pins it):

```json
{ "eventType": "OrderConfirmed",          // OrderCreated | OrderConfirmed | OrderCancelled
  "version": 1, "eventId": "uuid", "orderId": "uuid", "occurredAt": "2026-09-20T13:14:10.028Z",
  "source": "order", "correlationId": "trace-final-8", "userId": "user_…",
  "status": "CONFIRMED", "totalInPaise": 279900, "currency": "INR",
  "reason": "…",                          // OrderCancelled only
  "items": [ { "productId": "…", "sku": "…", "quantity": 1, "unitPriceInPaise": 279900 } ] }
```
Headers: `X-Request-Id`, `X-Event-Type`, `X-Event-Id`, `X-Event-Version`,
`X-Source: order`, `Content-Type`. `OrderCreated` is informational (both
consumers log-and-ignore it). **No contract mismatch was found**: Inventory
reacts to `OrderConfirmed`/`OrderCancelled`, Payment to `OrderCancelled`, and
both behaved as documented during verification.

### Consumes `payment-events` and `inventory-events`

Group `ORDER_KAFKA_CONSUMER_GROUP`, manual acks after the transaction
committed, retry with exponential backoff (`ORDER_KAFKA_RETRY_*`), then the
topic's own dead-letter topic: `payment-events.order.dlt`,
`inventory-events.order.dlt`. Malformed records go straight to the DLT;
unknown-order / not-ready records are retried first. A poison record never
blocks its partition beyond the bounded backoff. `X-Request-Id` is read from
the record header into the MDC and flows into everything the event causes.

---

## RabbitMQ — notification COMMANDS (`rabbit/RabbitTopology`, `infra/rabbitmq/declare-topology.sh`)

```
exchange notifications (topic, durable)  ─ order.* ─►  queue notification.tasks (durable, x-dead-letter-exchange = notifications.dlx)
exchange notifications.dlx (topic)       ─ #       ─►  queue notification.tasks.dlq
```
Published through the outbox with **publisher confirms** (`correlated`
confirms + `mandatory` returns; a nack, timeout or unroutable return is a
failed publish → retried). AMQP properties: `messageId =
notify-<orderId>-<routingKey>` (the consumer's dedupe key), `correlationId`,
`type = commandType`, `contentType application/json`, persistent delivery,
header `X-Request-Id`. Routing keys `order.confirmed` / `order.cancelled`. Body:

```json
{ "messageId": "notify-<orderId>-order.confirmed", "commandType": "SendOrderConfirmation",   // | SendOrderCancellation
  "version": 1, "source": "order", "occurredAt": "…", "correlationId": "…",
  "orderId": "…", "userId": "…", "status": "CONFIRMED", "totalInPaise": 279900, "currency": "INR",
  "reason": "…",                                                                              // cancellation only
  "items": [ { "productId", "sku", "name", "quantity", "unitPriceInPaise", "lineTotalInPaise" } ] }
```

**Why RabbitMQ here and Kafka for the saga.** A notification is a *command*:
"send this customer one e-mail" — a unit of work exactly one worker should
perform, acknowledge when done, retry on failure and park in a dead-letter
queue when it keeps failing. RabbitMQ gives per-message acks, redelivery and
DLX natively. The saga's messages are *events* — "the order was confirmed" —
durable facts that several independent consumer groups (Inventory, Payment,
later analytics) read at their own pace and can replay: Kafka's partitioned
log with per-group offsets.

---

## Correlation and logging

`web/CorrelationFilter` reuses the gateway's `X-Request-Id` (or mints one),
puts it in the MDC and echoes it; every outbound call forwards it; every
outbox message carries it (Kafka header + RabbitMQ property); every consumed
record's header is read back into the MDC. Verified with one id
(`trace-final-8`): 2 gateway lines → 22 order lines → 7 cart → 6 catalog →
7 inventory → 11 payment lines, on the `OrderCreated`/`OrderConfirmed`
records, on Inventory's and Payment's own events, and on the RabbitMQ
command's `correlation_id`.

## Layout

```
services/order/
├── pom.xml, mvnw, mvnw.cmd, .mvn/wrapper/
└── src/main/
    ├── resources/  application.yml · logback-spring.xml · META-INF/spring.factories · db/migration/V1__…sql
    └── java/com/orderflow/order/
        ├── config/      DotenvEnvironmentPostProcessor, ConfigGuard, OrderProperties, StartupReporter, ClockConfig
        ├── correlation/ Correlation
        ├── domain/      Order (aggregate + transitionTo), OrderStatus (state machine), OrderItem, OrderStatusHistory,
        │                ProcessedEvent, OutboxEvent, repositories (FOR UPDATE / SKIP LOCKED queries)
        ├── clients/     ServiceClient (breaker + timeout + correlation), Clients.{Cart,Catalog,Inventory,Payment}
        ├── service/     CheckoutService (sync zone + compensation), OrderService (events, cancel, reads), OrderReconciliationJob
        ├── outbox/      OutboxWriter (contracts), OutboxRelay (Kafka acks / RabbitMQ confirms)
        ├── kafka/       SagaEventsListener, KafkaConsumerConfig (retry + per-topic DLT), MalformedEventException
        ├── rabbit/      RabbitTopology
        ├── health/      DatabaseHealth, KafkaHealth, RabbitHealth
        └── web/         OrderController, RequireUser(+Resolver), HealthController, ApiExceptionHandler, CorrelationFilter
```
