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
                        │ OrderCreated               │ PaymentSucceeded / PaymentFailed
                        ▼  Kafka: order-events       │ Kafka: payment-events
                     Inventory (Postgres)            │
                        │ StockReserved / StockRejected
                        ▼  Kafka: inventory-events   │
                     Payment (Postgres, Razorpay) ───┘
                        │
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
| Topics / queues | `order-events`, `inventory-events`, `payment-events` (created explicitly; auto-create is off) | `notification.tasks` → retry → `notification.tasks.dlq` |
| Producers | Order, Inventory, Payment | Order (and later others) |
| Consumers | Inventory, Payment, Order | Notification Worker |
| Semantics | Append-only log, replayable, one event may have many consumers | Work item consumed once, acked, retried on failure, dead-lettered when exhausted |

Rule of thumb: *something happened* → Kafka; *please do this* → RabbitMQ.

### Saga (choreography, no orchestrator)

1. Order: `OrderCreated` → `order-events`
2. Inventory: reserve stock → `StockReserved` or `StockRejected` → `inventory-events`
3. Payment (on `StockReserved`): charge via Razorpay → `PaymentSucceeded` or
   `PaymentFailed` → `payment-events`
4. Order: on `PaymentSucceeded` → `CONFIRMED`; on `StockRejected` / `PaymentFailed`
   → `CANCELLED` (and Inventory releases stock on `PaymentFailed`).
5. Order enqueues a notification task for the customer.

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
