# OrderFlow — Architecture Notes

Short, binding rules for every later step. If a change breaks one of these, the
change is wrong.

## 1. Topology

```
Browser (React + Clerk)
        │  HTTPS, Clerk session token
        ▼
┌─────────────────┐
│   API Gateway   │  verifies JWT, injects X-User-Id, proxies by path
└───┬────┬────┬───┘
    │    │    │              HTTP (sync)
    ▼    ▼    ▼
 Catalog Cart  Order ◄──────────────────────────────┐
 (Mongo) (Redis+Mongo) (Postgres)                   │
              │         │  POST /reserve (sync HTTP) │ PaymentSucceeded / PaymentFailed
              │         ▼                            │ Kafka: payment-events
              │      Inventory (Postgres) ──► Payment (Postgres, Razorpay) ───┘
              │         ▲      │
              │         │      │ InventoryReserved / InventoryConfirmed /
              │         │      │ InventoryReleased / InventoryConfirmFailed
              │         │      ▼  Kafka: inventory-events  ──► Order
              │  OrderConfirmed / OrderCancelled
              └──────── Kafka: order-events (from Order)
 Order ──► RabbitMQ (notifications exchange) ──► Notification Worker
                       retry ➜ dead-letter queue
```

Only the gateway is public. Services never expose ports to the browser.

## 2. Data ownership (non-negotiable)

| Store | Database | Sole owner | Enforced by |
| --- | --- | --- | --- |
| PostgreSQL | `order_db` | Order | dedicated role `ORDER_DB_USER`; `CONNECT` revoked from `PUBLIC` |
| PostgreSQL | `inventory_db` | Inventory | dedicated role `INVENTORY_DB_USER`; `CONNECT` revoked from `PUBLIC` |
| PostgreSQL | `payment_db` | Payment | dedicated role `PAYMENT_DB_USER`; `CONNECT` revoked from `PUBLIC` |
| MongoDB | `catalog_db` | Catalog | separate `CATALOG_MONGO_URI` pointing only at this database |
| MongoDB | `cart_db` | Cart | separate `CART_MONGO_URI` pointing only at this database |
| Redis | db 0 | Cart | only the Cart service holds `REDIS_*` |

- A service connects to **exactly one** database with **its own** credentials.
- No cross-service SQL, no shared collections, no "just read their table".
- To get another service's data: call its HTTP API, or consume its events.
- The Postgres superuser is used by the init script only; no application ever
  receives it.
- MongoDB databases are created lazily by the owning service on first write.
  The infrastructure never pre-creates them.

## 3. Messaging: Kafka vs RabbitMQ

| | Kafka | RabbitMQ |
| --- | --- | --- |
| Role | **Domain events** and **saga choreography** | **Task queue** for side-effects |
| Topics / queues | `order-events`, `inventory-events`, `payment-events` + per-consumer dead-letter topics such as `order-events.inventory.dlt` (created explicitly by `infra/kafka/create-topics.sh`; auto-create is off) | `notification.tasks` → retry → `notification.tasks.dlq` |
| Producers | Order, Inventory, Payment | Order (and later others) |
| Consumers | Inventory, Payment, Order | Notification Worker |
| Semantics | Append-only log, replayable, one event may have many consumers | Work item consumed once, acked, retried on failure, dead-lettered when exhausted |

Rule of thumb: *something happened* → Kafka; *please do this* → RabbitMQ.

### Saga (choreography, no orchestrator)

Stock is held **synchronously** at checkout and settled **asynchronously**
(decided in Step 4 — see `services/inventory/README.md` for the contracts):

1. Order calls Inventory `POST /reserve { orderId, items }` (HTTP). Inventory
   moves `available → reserved` under row locks and answers `201` with a
   time-limited hold (or `409 insufficient_stock` naming the short products —
   nothing held). Inventory also publishes `InventoryReserved` → `inventory-events`.
2. Order calls Payment `POST /payments { orderId, userId, amountInPaise,
   currency }` (HTTP, server-to-server — the browser never sets the amount).
   Payment records the attempt, creates the Razorpay order and returns what
   the browser needs to open the widget. The customer completes 2FA with
   Razorpay directly (RBI: user-present, never a background step); Razorpay's
   signed webhook tells Payment the outcome → `PaymentSucceeded` or
   `PaymentFailed` → `payment-events`. A reconciliation job covers missed
   webhooks.
3. Order: on `PaymentSucceeded` → `CONFIRMED` and publishes `OrderConfirmed` →
   `order-events`; on `PaymentFailed` (or a user cancel) → `CANCELLED` and
   publishes `OrderCancelled`.
4. Inventory (consuming `order-events`): `OrderConfirmed` → the hold becomes a
   permanent deduction (`InventoryConfirmed`); `OrderCancelled` → the hold is
   released (`InventoryReleased`, reason `ORDER_CANCELLED`). A hold nobody
   settles within `INVENTORY_HOLD_DURATION_MS` is released by Inventory's expiry
   sweeper (`InventoryReleased`, reason `EXPIRED`); an `OrderConfirmed` that
   arrives after that yields `InventoryConfirmFailed` for Order to handle.
   Payment (also consuming `order-events`): `OrderCancelled` for a PAID order
   → refund with Razorpay → `PaymentRefunded`; the refund row's UNIQUE
   constraint makes a second cancellation harmless. Inventory, on the same
   event, restocks a CONFIRMED hold (`CONFIRMED → RESTOCKED`, once) →
   `InventoryRestocked` — so a cancelled paid order returns both the money
   and the goods.
   Records a consumer cannot process after retries land on that consumer's own
   dead-letter topic (`order-events.inventory.dlt`, `order-events.payment.dlt`).
5. Order writes a notification COMMAND (`SendOrderConfirmation` /
   `SendOrderCancellation`, stable `messageId`) to RabbitMQ exchange
   `notifications` → queue `notification.tasks` (DLX `notifications.dlx` →
   `notification.tasks.dlq`); the Step 7 worker consumes it.
6. Order's own state changes and the messages they cause are written in one
   transaction (`outbox_event`) and relayed afterwards — at-least-once, so every
   consumer deduplicates on the message id.

Every Kafka record is keyed by `orderId` and carries the `X-Request-Id`
correlation header; all events of one order share a partition.

## 4. Configuration

- **Everything** configurable comes from environment variables, listed in
  `.env.example`. No defaults in code that would silently work in one
  environment and break in another.
- One root `.env` feeds every service and Compose, so every port / URL
  variable is prefixed by service name (`ORDER_PORT`, `CATALOG_SERVICE_URL`, …).
- Local vs deployed differs **only** in values: `localhost` → container /
  VM hostnames, `localhost:9092` → `kafka:29092`, test keys → live keys.

## 5. Kafka dual listeners

The broker advertises two addresses because clients are redirected to the
advertised address after bootstrap:

| Listener | Address | Who uses it |
| --- | --- | --- |
| `INTERNAL` | `kafka:29092` | containers on the `orderflow-net` network (Kafka UI now; the services once containerised) |
| `EXTERNAL` | `${KAFKA_EXTERNAL_HOST}:9092` | services running on the host (this step), tools on the laptop |

Switching a service from host to container is a one-line change of
`KAFKA_BOOTSTRAP_SERVERS`.

## 6. Reproducibility

- Image tags are exact (`postgres:16.9-alpine`, `mongo:7.0.16`,
  `redis:7.4.2-alpine`, `apache/kafka:3.9.1`, `rabbitmq:3.13.7-management-alpine`,
  `ghcr.io/kafbat/kafka-ui:v1.1.0`, `mongo-express:1.0.2-20`,
  `ghcr.io/joeferner/redis-commander:0.8.1`). Never `latest`.
- Named volumes (`orderflow_*`) keep data across restarts; `down -v` wipes it.
- `.gitattributes` forces LF on shell scripts and YAML so Windows checkouts do
  not corrupt Linux-executed files.
- Maven wrapper files (`mvnw`, `.mvn/wrapper/*`) are committed so a fresh clone
  builds without a global Maven.

## 7. Deployment target

A single Linux VM running this same Compose file (plus, later, the application
containers) with a different `.env`. Nothing in the stack assumes more than one
machine, and the whole thing fits in ~2 GB of RAM.
