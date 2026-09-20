# Inventory Service

The single owner of stock. Its one job is to guarantee that OrderFlow **never
sells more units than exist**, even when many users check out at the same
instant. Everything else — endpoints, events, the sweeper — exists to serve
that guarantee.

Stack: **Java 17 · Spring Boot 3.5 · Spring Web · Spring Data JPA (Hibernate) ·
PostgreSQL · Flyway · spring-kafka · Bean Validation · Actuator ·
logstash-logback-encoder** (JSON logs). Maven with the wrapper committed. The
first Java service in the repo; Order and Payment follow the same layout.

**Lombok is not used.** DTOs are Java records, entities have explicit
accessors — no annotation processor, nothing IDE-specific.

Connects to PostgreSQL **`inventory_db`** (as `INVENTORY_DB_USER`) and Kafka —
nothing else. It never opens `order_db` or `payment_db`: the config guard
refuses to start if `INVENTORY_DB_URL` names another database, and the
database role cannot connect to them anyway (see Step 0).

---

## Run it

Prerequisites: JDK 17 (`JAVA_HOME` pointing at it), the infrastructure up
(`docker compose --env-file .env -f infra/docker-compose.yml up -d`), the
Kafka topics created, and the root `.env` in place.

```bash
# once: create the topics (auto-creation is off on the broker)
bash infra/kafka/create-topics.sh                 # from the project root

cd services/inventory
./mvnw clean package                              # → target/inventory-service.jar (also runs unit tests)
java -jar target/inventory-service.jar            # listens on INVENTORY_PORT (8082)
#   or: ./mvnw spring-boot:run

scripts/seed.sh                                   # stock rows for every Catalog product (needs Catalog running)
scripts/seed.sh --update                          # also reset existing rows to the seed quantities

./mvnw test                                       # 14 unit tests, no infrastructure needed
./mvnw test -Pit                                  # 7 in-process concurrency tests (incl. restock idempotency & restock-vs-reserve race) against the real inventory_db
node scripts/concurrency-test.mjs single --units 1 --requests 50   # live proof against a running service
node scripts/concurrency-test.mjs deadlock --requests 40
node scripts/concurrency-test.mjs idempotent --requests 30
```

Windows: `mvnw.cmd`, `scripts\seed.cmd`; the bash scripts run under Git Bash.

Configuration comes from the **root `.env`** (loaded by
`config/DotenvEnvironmentPostProcessor`; a real process variable always wins)
— nothing is hardcoded in `application.yml`. Every variable is validated at
start-up by `config/ConfigGuard`, which lists **all** problems at once and
refuses to boot:

```
APPLICATION FAILED TO START
Description:
The Inventory Service refused to start because its configuration is invalid:
  - INVENTORY_LOCK_TIMEOUT_MS must be a whole number (got "abc")
  - INVENTORY_KAFKA_CONSUMER_GROUP is required but missing or empty
  - INVENTORY_DB_URL points at database "order_db" but this service owns "inventory_db" (INVENTORY_DB_NAME) — refusing to touch another service's database
```

Through the gateway every path below is prefixed with `/api/inventory` and
needs a Clerk session token; the gateway strips the prefix and injects
`X-User-Id` / `X-Request-Id`.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `INVENTORY_PORT` | Listen port (8082) |
| `INVENTORY_DB_URL`, `INVENTORY_DB_USER`, `INVENTORY_DB_PASSWORD`, `INVENTORY_DB_NAME` | The owned database. The URL **must** name `INVENTORY_DB_NAME`. |
| `INVENTORY_DB_POOL_SIZE` | Hikari pool size (a waiting row lock holds a connection) |
| `INVENTORY_LOCK_TIMEOUT_MS` | `SET lock_timeout` on every pooled connection → `503 stock_lock_timeout` instead of waiting forever |
| `INVENTORY_HOLD_DURATION_MS` | Hold lifetime (600000 = the 10-minute India OTP window) |
| `INVENTORY_SWEEPER_INTERVAL_MS`, `INVENTORY_SWEEPER_BATCH_SIZE` | Expiry sweeper cadence and batch size |
| `INVENTORY_RESERVE_MAX_ITEMS`, `INVENTORY_MAX_QUANTITY_PER_ITEM`, `INVENTORY_BULK_LOOKUP_MAX_IDS` | Request limits (→ 400) |
| `INVENTORY_SHUTDOWN_TIMEOUT_MS` | Graceful-shutdown grace period |
| `KAFKA_BOOTSTRAP_SERVERS` | Broker(s) — `localhost:9092` on the host, `kafka:29092` in Docker |
| `KAFKA_TOPIC_ORDER_EVENTS`, `KAFKA_TOPIC_INVENTORY_EVENTS`, `KAFKA_TOPIC_ORDER_EVENTS_INVENTORY_DLT` | Consumed topic, published topic, dead-letter topic |
| `KAFKA_TOPIC_PARTITIONS`, `KAFKA_TOPIC_REPLICATION_FACTOR` | Used by `infra/kafka/create-topics.sh` only |
| `INVENTORY_KAFKA_CONSUMER_GROUP` | Consumer group id |
| `INVENTORY_KAFKA_RETRY_MAX_ATTEMPTS`, `_INITIAL_MS`, `_MULTIPLIER`, `_MAX_MS` | Consumer retry/backoff before dead-lettering |
| `LOG_LEVEL` | Level for `com.orderflow.inventory` loggers |
| `CATALOG_SERVICE_URL` | Seed mode only — where to fetch product ids |

---

## The two-number stock model

Stock is never one number. Each product row carries:

| Column | Meaning |
| --- | --- |
| `available` | Units a new buyer can claim right now |
| `reserved` | Units held by someone mid-checkout (entering an OTP) — not yet sold, not claimable |

Four operations move units between them:

```
                 RESERVE (sync, POST /reserve)              CONFIRM (async, OrderConfirmed)
   available  ─────────────────────────────────►  reserved  ───────────────────────────────►  (gone)
              ◄─────────────────────────────────                                                │
                 RELEASE (OrderCancelled, POST /release, or the expiry sweeper)                 │
              ◄─────────────────────────────────────────────────────────────────────────────────┘
                 RESTOCK (OrderCancelled on a CONFIRMED hold, or POST /restock)
```

- **RESERVE** creates a time-limited **hold** (`reservation`, status `HELD`,
  `expiresAt = now + INVENTORY_HOLD_DURATION_MS`). `available` drops
  immediately, so nobody else can claim those units while the buyer pays.
- **CONFIRM** makes the deduction permanent: `reserved` drops, `available` is
  untouched (it already dropped at reserve time). Status `CONFIRMED`.
- **RELEASE** is the compensating action before payment: `reserved` →
  `available`. Status `RELEASED` (cancellation / explicit) or `EXPIRED` (sweeper).
- **RESTOCK** is the compensating action after payment: a paid order was
  cancelled (Payment refunds the money, this service returns the goods), so
  the sold units come back: `available` += quantity, `reserved` untouched.
  Status `RESTOCKED`. Only a `CONFIRMED` hold can be restocked, and only once.

`HELD` is the only state that moves freely; `CONFIRMED` can move exactly once
more, to `RESTOCKED`; `RELEASED`, `EXPIRED` and `RESTOCKED` are final — which is
what makes confirm / release / expire / restock idempotent (below).

```
   HELD ──► CONFIRMED ──► RESTOCKED
     ├────► RELEASED
     └────► EXPIRED
```

---

## Schema (Flyway `V1__inventory_and_reservations.sql`, `V2__reservation_restocked_status.sql`)

Flyway owns the schema; Hibernate runs with `ddl-auto: validate` and only
checks that the entities match. Never edit an applied migration — add `V3__`.
V2 adds `RESTOCKED` to the `reservation_status_valid` CHECK
(`status IN ('HELD','CONFIRMED','RELEASED','EXPIRED','RESTOCKED')`) by dropping
and re-adding the constraint; V1 is untouched.

```
inventory                         reservation                          reservation_item
─────────────                     ─────────────                        ────────────────
product_id   VARCHAR(64) PK       id            UUID PK                id             BIGSERIAL PK
available    INT  ≥ 0  (CHECK)    order_id      VARCHAR(64) UNIQUE     reservation_id UUID → reservation (CASCADE)
reserved     INT  ≥ 0  (CHECK)    status        HELD|CONFIRMED|        product_id     VARCHAR(64) → inventory
version      BIGINT (@Version)                  RELEASED|EXPIRED       quantity       INT > 0 (CHECK)
created_at / updated_at           expires_at    TIMESTAMPTZ            UNIQUE (reservation_id, product_id)
                                  created_by_request_id
                                  resolved_at, version, created_at / updated_at
```

**Constraints**

- `inventory_available_non_negative`, `inventory_reserved_non_negative` —
  the **last line of defence**. Overselling is a negative `available`;
  releasing twice is a negative `reserved`. Even a bug or a hand-run SQL
  statement cannot persist either (verified: the database rejects it).
- `reservation_order_id_unique` — **idempotency enforced by the database**:
  only one hold can ever exist per order (details below).
- `reservation_status_valid`, `reservation_item_quantity_positive`,
  `reservation_item_product_unique` — no invalid states, no zero lines, no
  duplicate lines.
- A reservation is a **header + lines** so a multi-product order is one hold
  with one status: its lines are held, confirmed or released *together*.

**Indexes — each one serves a query the service actually runs**

| Index | Serves |
| --- | --- |
| `inventory_pkey (product_id)` | `GET /stock/{id}`, the `IN (...)` bulk lookup, the seed upsert and — most importantly — every `SELECT … FOR UPDATE` row lock. The only index this table needs. |
| `reservation_order_id_unique (order_id)` | The uniqueness rule **and** the lookup path for `POST /reserve` (replay check), `POST /release {orderId}` and every Kafka event, all keyed by order id. |
| `reservation_held_expires_idx (expires_at) WHERE status = 'HELD'` | The sweeper's `status = 'HELD' AND expires_at <= now() ORDER BY expires_at LIMIT n`. **Partial**: only live holds are in it, rows drop out the moment they leave `HELD`, so it stays tiny however many historical reservations accumulate. |
| `reservation_item_product_unique (reservation_id, product_id)` | Loading the lines of one hold (confirm / release / expiry / responses) — leading column `reservation_id`. |
| `reservation_item_product_idx (product_id)` | Reverse side of the FK to `inventory` (PostgreSQL does not index FK columns) and "which holds include product X?". |

`updated_at` is maintained by a trigger so it is correct for every writer,
including a psql session during a demo.

---

## The locking strategy — why this cannot oversell and cannot deadlock

Everything below lives in `service/InventoryService` and `service/LockOrder`.

**What is locked.** The `inventory` row of every product in the request, with
`SELECT … FOR UPDATE` (`@Lock(PESSIMISTIC_WRITE)` on
`InventoryRepository.lockByProductId`). For confirm / release / expiry the
`reservation` header row is locked first, the same way.

**For how long.** From the lock statement until the transaction commits or
rolls back — the whole check-then-decrement — typically a few milliseconds.
`SET lock_timeout = INVENTORY_LOCK_TIMEOUT_MS` is applied to every pooled
connection, so a waiter gives up after that long (PostgreSQL `55P03`) and the
API answers `503 stock_lock_timeout` instead of queueing behind a stuck
transaction. Verified: with a psql session holding the row, `POST /reserve`
returns the 503 after exactly 3.0 s.

**Why it cannot oversell.** Reading `available` and decrementing it happen
inside ONE transaction, and the row lock serialises every transaction that
touches that product. Two users buying the last unit: the second one's
`SELECT … FOR UPDATE` blocks until the first commits, then sees
`available = 0` and fails with 409. There is no window in which both see 1.
Verified: 50 simultaneous reserves for 1 unit → exactly 1 succeeds; for 5 units
→ exactly 5. And should any code path ever get it wrong, the CHECK constraint
refuses the negative row.

**All-or-nothing.** For a multi-item order every row is locked and checked
*before* anything is decremented. Any shortage (or unknown product) throws
`InsufficientStockException`; the transaction rolls back, the locks are
released, no row was changed, no reservation was written. The 409 names every
short product and by how much.

**In what order — the deadlock guard.** Two transactions that lock A then B and
B then A deadlock. So every transaction in this service acquires inventory row
locks in **ascending `productId` order**, whatever order the caller listed the
items in (`LockOrder.sorted`). With one global order a transaction can only ever
wait for rows that sort *after* the ones it holds, so a cycle of waits cannot
form. The reservation header, when one is locked, is always taken *before* any
inventory rows and only one per transaction, which keeps the order consistent
across both tables. The sweeper handles each expired hold in its own
transaction for the same reason. Verified: 40 concurrent two-item reserves,
half `[A,B]` and half `[B,A]` → 40 successes, zero deadlocks in the PostgreSQL
log.

**Kafka events are published only after the transaction has committed**, so a
consumer never sees an event for state that was rolled back.

`version` (JPA `@Version`) on both tables is belt-and-braces: any write that
somehow slipped past a row lock would still fail on a stale version.

---

## Idempotency guarantees

| Repeat | What happens |
| --- | --- |
| `POST /reserve` again with the same `orderId` | Returns the existing hold (`200`, `created: false`) — no second decrement. Three layers: (1) a lock-free pre-check; (2) the check is repeated *inside* the transaction after the row locks are held, catching a concurrent retry that raced past (1); (3) `UNIQUE (order_id)` catches anything else — the loser's transaction rolls back (its decrements vanish) and the winner's hold is returned. Verified: 30 simultaneous reserves with one `orderId` → 1 created, 29 replays, stock moved once. |
| `OrderConfirmed` delivered twice | The hold is already `CONFIRMED`; nothing changes, no event. |
| `OrderCancelled` / `POST /release` twice | The hold is already `RELEASED` / `EXPIRED`; nothing changes (`released: false`). |
| `OrderCancelled` for a paid order twice / `POST /restock` twice | The status transition `CONFIRMED → RESTOCKED` is applied as a conditional `UPDATE reservation SET status='RESTOCKED' WHERE id=? AND status='CONFIRMED'` under the row lock; units are added to `available` **only if that statement changed one row**. A second delivery finds `RESTOCKED`: the event path is a no-op, the explicit endpoint answers 409. Verified: 30 concurrent restocks → 1 applied; 40 simultaneous cancel + restock calls → stock +3 exactly once. |
| Sweeper overlapping itself or another instance | Row-level `FOR UPDATE SKIP LOCKED` + status re-check under the lock — a hold can be released exactly once. |

All state transitions lock the reservation row first, so two transitions of the
same hold serialise and the second sees the first's committed status.

---

## Endpoints

The gateway strips `/api/inventory`, so paths here have no prefix.

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/reserve` | `{ orderId, items: [{ productId, quantity }] }` → **201** new hold, **200** existing hold (replay), **409 `insufficient_stock`** with per-product shortages (nothing held), **503 `stock_lock_timeout`**. |
| `POST` | `/release` | `{ orderId }` **or** `{ reservationId }` — compensating action. `released: false` if already terminal. 404 `reservation_not_found`. |
| `POST` | `/restock` | `{ orderId }` — compensating action for a **paid** order that was cancelled: the `CONFIRMED` hold's units return to `available`, status `RESTOCKED`, `InventoryRestocked` published. **409 `reservation_not_restockable`** for `HELD` / `RELEASED` / `EXPIRED` and for a hold that was already `RESTOCKED` — a rejected call never changes stock. 404 `reservation_not_found`. (The same transition runs automatically when `OrderCancelled` arrives for a `CONFIRMED` hold; there the replay is a silent no-op.) |
| `GET` | `/stock/{productId}` | `{ productId, available, reserved, updatedAt }`. 404 `product_not_found`. |
| `POST` | `/stock/bulk` | `{ productIds: [...] }` → `{ stock: [...], unknown: [...], asOf }` — ONE `IN (...)` query, no N+1. |
| `POST` | `/stock/{productId}/adjust` | Admin: `{ operation: "SET" \| "ADD", quantity }`. Creates the row for a new product. `ADD` may be negative; going below zero → 409 `invalid_adjustment`. **TODO(auth-roles)**: restrict to an admin role once the gateway propagates roles (same TODO as Catalog). |
| `GET` | `/health` | Always 200. `status` = `ok` / `degraded` (a required topic is missing) / `unhealthy` (db or kafka down); `db` (database, user, Flyway version), `kafka` (cluster, brokers, topics), `sweeper` (last run, holds released). |
| `GET` | `/ready` | 200 iff PostgreSQL **and** Kafka are reachable, else 503. |
| `GET` | `/actuator/health` | Same facts in Actuator's format (`db`, `kafka` components). |

### `POST /reserve`

```json
// request
{ "orderId": "ord-123", "items": [ { "productId": "6aaed83ee6d0a57903f7bac4", "quantity": 2 } ] }

// 201 Created
{ "reservationId": "3d05cbae-…", "orderId": "ord-123", "status": "HELD", "created": true,
  "expiresAt": "2026-09-20T10:25:30.134Z", "createdAt": "2026-09-20T10:15:30.177Z",
  "items": [ { "productId": "6aaed83ee6d0a57903f7bac4", "quantity": 2, "outcome": "HELD" } ],
  "totalQuantity": 2 }

// 409 Conflict — nothing was reserved
{ "error": "insufficient_stock",
  "message": "Insufficient stock for 2 product(s) — nothing was reserved: 6aaed…bac4 (requested 9, available 5, short by 4); does-not-exist (requested 1, available 0, short by 1)",
  "requestId": "…",
  "details": [ { "productId": "6aaed…bac4", "requested": 9, "available": 5, "shortBy": 4, "reason": "insufficient" },
               { "productId": "does-not-exist", "requested": 1, "available": 0, "shortBy": 1, "reason": "unknown_product" } ] }
```

Validation: ids match `^[A-Za-z0-9._-]{1,64}$`; quantity ≥ 1 and ≤
`INVENTORY_MAX_QUANTITY_PER_ITEM`; at most `INVENTORY_RESERVE_MAX_ITEMS`
lines; a product may appear only once. Failures → `400 validation_error` with
`details: [{ field, message }]`.

### Errors

Every error uses the OrderFlow shape `{ error, message, requestId[, details] }`
(`web/ApiExceptionHandler`). Nothing from the database, driver or JVM reaches a
client — SQL and lock errors become `409 conflict` / `503 stock_lock_timeout`
/ `503 database_unavailable`; anything unexpected is logged with its stack
trace and answered `500 internal_error`. Codes: `validation_error`,
`invalid_json`, `not_found`, `method_not_allowed`, `unsupported_media_type`,
`product_not_found`, `reservation_not_found`, `insufficient_stock`,
`invalid_adjustment`, `conflict`, `stock_lock_timeout`,
`database_unavailable`, `internal_error`.

---

## Kafka

Topics are created explicitly by `infra/kafka/create-topics.sh` (the broker has
auto-creation off). Records are keyed by `orderId`, so every event about one
order is on one partition and consumed in order; 3 partitions, replication 1
on the single broker.

### Consumes `order-events` (from Order Service, Step 6)

Expected envelope — extra fields are ignored, other event types are skipped:

```json
{ "eventType": "OrderConfirmed" | "OrderCancelled", "version": 1,
  "eventId": "…", "orderId": "ord-123", "occurredAt": "2026-09-20T10:20:00Z" }
```
with the record header `X-Request-Id` carrying the correlation id.

| Event | Effect |
| --- | --- |
| `OrderConfirmed` | `HELD` → `CONFIRMED`; `reserved` drops permanently. Already `CONFIRMED` → no-op. `RELEASED`/`EXPIRED` (payment landed after the hold died) → **not** deducted; `InventoryConfirmFailed` is published so Order can react. |
| `OrderCancelled` | `HELD` (unpaid order) → `RELEASED`: `reserved` → `available`. `CONFIRMED` (paid order being refunded) → `RESTOCKED`: sold units → `available`. `RELEASED` / `EXPIRED` / `RESTOCKED` → no-op. Both branches run under the same reservation row lock, so a redelivered event sees the status the first delivery committed. |

Consumer group `INVENTORY_KAFKA_CONSUMER_GROUP`; `enable.auto.commit=false`,
`ack-mode: manual_immediate` — the offset is committed only after the service
call returned (or after the record was dead-lettered). Idempotent by
construction: the status is checked under a row lock before acting.

**Retry and dead letters** (`kafka/KafkaConsumerConfig`): a failing record is
retried in place with exponential backoff (`INVENTORY_KAFKA_RETRY_*`: 3
retries, 1 s → 2 s → 4 s by default), then copied to the **dead-letter topic
`order-events.inventory.dlt`** (`KAFKA_TOPIC_ORDER_EVENTS_INVENTORY_DLT`) —
same partition number, original key/value/headers plus Spring's
`kafka_dlt-*` headers (original topic/partition/offset, exception class and
message) — and the partition moves on. Malformed records (not JSON, missing
`eventType`/`orderId`) are not retryable and go to the DLT immediately.
A poison message can delay its partition by the sum of the backoffs, never
block it. Manual publishing for demos: `scripts/publish-order-event.sh`.

### Publishes `inventory-events` — THE CONTRACT for Order Service (Step 6)

Record **key** = `orderId`. **Headers**:

| Header | Value |
| --- | --- |
| `X-Request-Id` | Correlation id of the originating request (the same value the REST response carried; `sweep-…` for the sweeper) |
| `X-Event-Type` | `InventoryReserved` \| `InventoryConfirmed` \| `InventoryReleased` \| `InventoryConfirmFailed` \| `InventoryRestocked` |
| `X-Event-Id` | UUID, unique per event — a consumer's dedupe key |
| `X-Event-Version` | `1` |
| `X-Source` | `inventory` |
| `Content-Type` | `application/json` |

**Value** (`service/InventoryEvent`; absent fields are omitted, never `null`):

```json
{
  "eventId":       "575a95bc-663b-4f35-93b4-74a5a973538d",
  "eventType":     "InventoryReserved",
  "version":       1,
  "source":        "inventory",
  "occurredAt":    "2026-09-19T23:08:46.248Z",
  "correlationId": "demo-reserve-A",
  "orderId":       "ord-A",
  "reservationId": "3d05cbae-b98c-4777-987d-5d47672e2c94",
  "expiresAt":     "2026-09-19T23:18:46.134Z",
  "items":         [ { "productId": "6aaed83ee6d0a57903f7bac4", "quantity": 3 } ]
}
```

| `eventType` | When | Extra fields |
| --- | --- | --- |
| `InventoryReserved` | `POST /reserve` created a hold | `expiresAt` |
| `InventoryConfirmed` | `OrderConfirmed` turned the hold into a permanent deduction | — |
| `InventoryReleased` | The hold went back to `available` | `reason`: `ORDER_CANCELLED` \| `EXPLICIT_RELEASE` \| `EXPIRED` |
| `InventoryConfirmFailed` | `OrderConfirmed` arrived for a hold that is no longer `HELD`; stock **not** deducted | `reason`: the hold's status (`EXPIRED` \| `RELEASED`) |
| `InventoryRestocked` | a `CONFIRMED` hold's units were returned to `available` (paid order cancelled) | `reason`: `ORDER_CANCELLED` \| `EXPLICIT_RESTOCK`; `items` = the units returned |

Additions bump `version`; existing fields never change meaning. Sends are
asynchronous (`acks=all`, idempotent producer) and never block the HTTP
response; a failed send is logged as an error with every id needed to replay
it. (A transactional outbox would close that gap — deliberately out of scope.)

---

## The expiry sweeper

`service/ExpirySweeper`, `@Scheduled(fixedDelay = INVENTORY_SWEEPER_INTERVAL_MS)`.
A hold nobody confirms or cancels (the customer closed the tab on the OTP
screen) would keep its units in `reserved` forever. Every interval the sweeper:

1. Selects up to `INVENTORY_SWEEPER_BATCH_SIZE` ids where
   `status = 'HELD' AND expires_at <= now()` (the partial index; no locks).
2. For **each** id, in its **own** transaction: re-selects the row with
   `FOR UPDATE SKIP LOCKED` **and the same predicates**, locks the inventory
   rows in `LockOrder`, moves `reserved → available`, sets `EXPIRED`.
3. After commit, publishes `InventoryReleased { reason: "EXPIRED" }` and logs
   at WARN:

```json
{"time":"2026-09-19T23:23:51.250Z","msg":"HOLD EXPIRED — released back to available","level":"WARN","requestId":"sweep-babb368f","orderId":"ord-EXP","reservationId":"dcaa62af-…","expiredAt":"2026-09-19T23:23:49.044833Z","items":[{"productId":"6aaed83ee6d0a57903f7bac4","quantity":2}],"totalQuantity":2,"overdueMs":2193,"name":"inventory"}
{"time":"2026-09-19T23:23:51.251Z","msg":"sweep finished","level":"INFO","requestId":"sweep-babb368f","expiredHolds":1,"name":"inventory"}
```

Safe under overlap and across instances: `SKIP LOCKED` makes two sweepers
work on disjoint rows; the predicates re-evaluated under the lock mean a hold
confirmed or released in the meantime is left alone; one transaction per hold
keeps the lock order intact. `fixedDelay` never overlaps a run with itself in
one JVM. `/health` reports `lastRunAt`, `lastRunReleased`, `totalReleased`.

For a demo, override in the process environment (it wins over `.env`):
`INVENTORY_HOLD_DURATION_MS=5000 INVENTORY_SWEEPER_INTERVAL_MS=3000 java -jar …`.

---

## Correlation and logging

- `web/CorrelationFilter` runs first on every request: reuses the gateway's
  `X-Request-Id` (or mints one), puts it in the MDC as `requestId`, echoes it
  in the response header, and writes one line per request
  `{ requestId, req: {method,url}, res: {status}, durationMs }` — like the
  Node services.
- Every Kafka record published carries the id in the `X-Request-Id` header;
  the consumer reads it back into the MDC before handling a record. One user
  action is therefore traceable REST → log → Kafka header → consumer log.
- Logs are JSON, one object per line (`logback-spring.xml`), with the same key
  names as pino: `time`, `level`, `name`, `requestId`, `msg`, plus structured
  fields (`orderId`, `reservationId`, `items`, …). Stack traces appear in logs
  only, never in responses.

## Graceful shutdown

`server.shutdown: graceful` + `spring.lifecycle.timeout-per-shutdown-phase =
INVENTORY_SHUTDOWN_TIMEOUT_MS`. On SIGTERM/SIGINT: the HTTP connector stops
accepting, in-flight requests and transactions finish, the Kafka listener
container completes the record in hand and closes the consumer, the sweeper's
scheduler drains, the pool closes. (On Windows, `taskkill` without `/F` does
not deliver a signal to a console JVM; use Ctrl+C in its console.)

## Seed

`scripts/seed.sh` runs the jar with the `seed` profile (no HTTP server, no
consumer, no sweeper): it fetches `GET CATALOG_SERVICE_URL/products?limit=100`
— through Catalog's API, never its database — and upserts one `inventory` row
per product (`ON CONFLICT DO NOTHING`; `--update` resets `available`). Seed
quantities are deterministic per SKU (5–60 units), so demo numbers are stable.

## Layout

```
services/inventory/
├── pom.xml, mvnw, mvnw.cmd, .mvn/wrapper/          Maven 3.9.16 wrapper (committed)
├── scripts/
│   ├── seed.sh, seed.cmd                            explicit seed (profile "seed")
│   ├── concurrency-test.mjs                         live concurrency / deadlock / idempotency proof
│   └── publish-order-event.sh                       publish OrderConfirmed / OrderCancelled / poison by hand
└── src/main/
    ├── resources/
    │   ├── application.yml                          every value = ${ENV_VAR}, no defaults
    │   ├── application-seed.yml                     seed profile
    │   ├── logback-spring.xml                       JSON logs
    │   ├── META-INF/spring.factories                registers the .env loader, ConfigGuard, failure analyzer
    │   └── db/migration/V1__inventory_and_reservations.sql
    └── java/com/orderflow/inventory/
        ├── InventoryApplication.java
        ├── config/      DotenvEnvironmentPostProcessor, ConfigGuard (+ failure analyzer), InventoryProperties, StartupReporter, ClockConfig
        ├── correlation/ Correlation (X-Request-Id ↔ MDC ↔ Kafka header)
        ├── domain/      Inventory, Reservation, ReservationItem, ReservationStatus, repositories (FOR UPDATE / SKIP LOCKED queries)
        ├── service/     InventoryService (reserve/confirm/release/adjust), LockOrder, ExpirySweeper, InventoryEvent (contract), views, exceptions
        ├── kafka/       KafkaInventoryEventPublisher, OrderEventsListener, KafkaConsumerConfig (retry + DLT), MalformedEventException
        ├── health/      DatabaseHealth, KafkaHealth (also an Actuator indicator)
        ├── web/         InventoryController, HealthController, ApiExceptionHandler, CorrelationFilter, ApiDtos
        └── seed/        SeedRunner
```
