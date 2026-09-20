# OrderFlow — Developer Guide

## Overview

OrderFlow is an event-driven e-commerce backend built as a set of independent
microservices. A React storefront talks to a single **API Gateway**, which verifies
the user's Clerk session and proxies each request to the right service. Product
data lives in a **Catalog** service, the shopping basket in a **Cart** service
(Redis cache in front of MongoDB), and checkout is handled as a **saga**: the
**Order** service asks the **Inventory** service to hold stock (a synchronous
call that can never oversell, backed by a time-limited hold), the **Payment**
service takes the money through Razorpay and replies with an event, Order
publishes `OrderConfirmed` / `OrderCancelled`, and Inventory settles or releases
the hold in response (or lets it expire). Customer-facing messages are pushed onto a
RabbitMQ queue and delivered by a **Notification** worker with retry and a
dead-letter queue. Every service owns its own database and nothing else touches
it — services only talk over HTTP or through events.

See [architecture.md](architecture.md) for the data-ownership and messaging rules.

### Services

| Service | Language / framework | Datastore (owned exclusively) | Messaging | Port (host) |
| --- | --- | --- | --- | --- |
| API Gateway | Node.js + Express | — (stateless) | — | `GATEWAY_PORT` = 4000 |
| Catalog | Node.js + Express | MongoDB `catalog_db` | — | `CATALOG_PORT` = 4001 |
| Cart | Node.js + Express | Redis (cache) + MongoDB `cart_db` (source of truth) | — | `CART_PORT` = 4002 |
| Order | Java 17 + Spring Boot 3 | PostgreSQL `order_db` | Kafka producer + consumer, RabbitMQ producer | `ORDER_PORT` = 8081 |
| Inventory | Java 17 + Spring Boot 3 | PostgreSQL `inventory_db` | Kafka producer + consumer | `INVENTORY_PORT` = 8082 |
| Payment | Java 17 + Spring Boot 3 | PostgreSQL `payment_db` | Kafka producer + consumer, Razorpay | `PAYMENT_PORT` = 8083 |
| Notification Worker | Node.js | — | RabbitMQ consumer | `NOTIFICATION_PORT` = 4003 |

> **Progress:** Steps 0 (infrastructure), 1 (API Gateway), 2 (Catalog),
> 3 (Cart) and 4 (Inventory) are done. The other services are placeholders
> (see each `services/<name>/README.md`) and are built in the later steps
> listed at the bottom of this page.

## Repository layout

```
ecommerce-microservices/
├── .env.example          # every environment variable, documented (committed)
├── .env                  # your local values (gitignored)
├── .gitattributes        # forces LF on *.sh etc. so Linux containers can run them
├── docs/                 # this guide + architecture notes
├── infra/
│   ├── docker-compose.yml        # all backing infrastructure + management UIs
│   ├── postgres/init/            # creates the three Postgres databases on first start
│   └── kafka/create-topics.sh    # creates the Kafka topics (auto-creation is off)
└── services/
    ├── api-gateway/  catalog/  cart/  order/  inventory/  payment/  notification/
```

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Docker Desktop | 4.x with Compose v2 (`docker compose`, not `docker-compose`) | WSL 2 backend on Windows. ~2 GB RAM free for the stack. |
| Node.js | 20 LTS or 22 LTS | For the Node services (later steps). |
| Java | 17 (Temurin / Oracle) | For the Spring Boot services. Point `JAVA_HOME` at it. |
| Maven | none needed | Each Java service ships the Maven wrapper (`./mvnw` / `mvnw.cmd`), which downloads Maven 3.9.16 on first use. |
| Git | any recent | `core.autocrlf` may be on; `.gitattributes` keeps shell scripts LF anyway. |

## Running the infrastructure

All commands run from the **project root** (the folder containing `.env`).
Compose reads credentials and ports from `.env` via `--env-file`.

First time only:

```bash
cp .env.example .env      # then edit the change_me_* values (any letters/digits/_)
```

Start everything (detached) and wait for health:

```bash
docker compose --env-file .env -f infra/docker-compose.yml up -d
docker compose --env-file .env -f infra/docker-compose.yml ps
```

Follow logs (all, or one service):

```bash
docker compose --env-file .env -f infra/docker-compose.yml logs -f
docker compose --env-file .env -f infra/docker-compose.yml logs -f kafka
```

Stop, keeping all data (volumes survive):

```bash
docker compose --env-file .env -f infra/docker-compose.yml down
```

Stop **and wipe all data** (also re-runs the Postgres init script next time):

```bash
docker compose --env-file .env -f infra/docker-compose.yml down -v
```

> Tip: on a long-running machine, `docker compose ... restart <service>` restarts
> one container without touching the others.

## Running the API Gateway (Step 1)

The gateway runs on the host and reads the root `.env`. It needs **real Clerk
test keys** (`CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` from
dashboard.clerk.com → API Keys) — the placeholders are rejected at start-up.

```bash
cd services/api-gateway
npm install
npm start            # http://localhost:4000  (GATEWAY_PORT)
npm test             # 26 integration tests, no infrastructure needed
```

It starts even when every downstream service is down; those routes answer
`503 { "error": "service_unavailable" }` until the service exists. Details,
route table and error catalogue: [services/api-gateway/README.md](../services/api-gateway/README.md).

## Running the Catalog Service (Step 2)

```bash
cd services/catalog
npm install
npm run seed         # 14 demo products into catalog_db (idempotent)
npm start            # http://localhost:4001  (CATALOG_PORT)
npm test             # 31 integration tests against catalog_test_db (needs MongoDB up)
```

With the gateway also running: `curl http://localhost:4000/api/catalog/products`.
Prices are integers in paise (`priceInPaise` + `currency`) — the money rule and
the bulk price-lookup contract that Cart and Order will use are in
[services/catalog/README.md](../services/catalog/README.md).

## Running the Cart Service (Step 3)

```bash
cd services/cart
npm install
npm start            # http://localhost:4002  (CART_PORT) — needs MongoDB; Redis optional; Catalog for prices
npm test             # 22 integration tests (real MongoDB + Redis, fake Catalog)
```

Cache-aside (MongoDB `cart_db` is the truth, Redis a TTL copy), no price is
ever stored, live prices via Catalog behind an opossum circuit breaker, and a
strict `GET /snapshot` for checkout — all in
[services/cart/README.md](../services/cart/README.md).

Authenticated end-to-end (`/api/cart` through the gateway) needs a Clerk
session token; `CLERK_AUTHORIZED_PARTIES` must be empty for server-minted tokens.

## Running the Inventory Service (Step 4)

The first Java service. Needs JDK 17, PostgreSQL (`inventory_db`) and Kafka
with the topics created:

```bash
bash infra/kafka/create-topics.sh      # once, from the project root: order-events, inventory-events, order-events.inventory.dlt

cd services/inventory
./mvnw clean package                   # builds target/inventory-service.jar, runs 13 unit tests
java -jar target/inventory-service.jar # http://localhost:8082  (INVENTORY_PORT) — reads ../../.env
scripts/seed.sh                        # one stock row per Catalog product (Catalog must be running)
./mvnw test -Pit                       # 4 in-process concurrency tests against the real inventory_db
node scripts/concurrency-test.mjs single --units 1 --requests 50   # live oversell proof
```

Two-number stock (`available` / `reserved`), `SELECT … FOR UPDATE` row locks
in a deterministic order, all-or-nothing multi-item holds, an expiry sweeper,
and the `inventory-events` contract Order will consume — all in
[services/inventory/README.md](../services/inventory/README.md).

## Ports and management UIs

Host ports come from `.env`; the values below are the defaults in `.env.example`.
If a port is taken on your machine (e.g. a locally installed MongoDB on 27017),
change the variable — nothing else needs to change.

### Backing services (used by the application code)

| Container | Host address | `.env` variables | Credentials (`.env`) |
| --- | --- | --- | --- |
| PostgreSQL 16 | `localhost:5432` | `POSTGRES_PORT` | Per service: `ORDER_DB_USER/PASSWORD`, `INVENTORY_DB_USER/PASSWORD`, `PAYMENT_DB_USER/PASSWORD`. Superuser `POSTGRES_SUPERUSER/PASSWORD` (init only). |
| MongoDB 7 | `localhost:27017` | `MONGO_PORT` | `MONGO_ROOT_USER` / `MONGO_ROOT_PASSWORD` (authSource=admin) |
| Redis 7 | `localhost:6379` | `REDIS_PORT` | `REDIS_PASSWORD` |
| Kafka 3.9 (KRaft) — EXTERNAL listener | `localhost:9092` | `KAFKA_EXTERNAL_PORT` | none (PLAINTEXT) |
| Kafka — INTERNAL listener (containers only) | `kafka:29092` | `KAFKA_INTERNAL_PORT` | none (PLAINTEXT) |
| RabbitMQ 3.13 (AMQP) | `localhost:5672` | `RABBITMQ_PORT` | `RABBITMQ_USER` / `RABBITMQ_PASSWORD` |

### Management UIs (for browsing and demo recordings)

| UI | URL | `.env` variables | Login |
| --- | --- | --- | --- |
| Kafka UI (kafbat) | <http://localhost:8090> | `KAFKA_UI_PORT` | none |
| RabbitMQ Management | <http://localhost:15672> | `RABBITMQ_MANAGEMENT_PORT` | `RABBITMQ_USER` / `RABBITMQ_PASSWORD` |
| mongo-express | <http://localhost:8091> | `MONGO_EXPRESS_PORT` | browser basic-auth prompt: `MONGO_EXPRESS_USER` / `MONGO_EXPRESS_PASSWORD` |
| redis-commander | <http://localhost:8092> | `REDIS_COMMANDER_PORT` | login form: `REDIS_COMMANDER_USER` / `REDIS_COMMANDER_PASSWORD` |

### Application services (built in later steps — reserved now so nothing collides)

| Service | Host port | `.env` variable |
| --- | --- | --- |
| API Gateway | 4000 | `GATEWAY_PORT` |
| Catalog | 4001 | `CATALOG_PORT` |
| Cart | 4002 | `CART_PORT` |
| Notification Worker (health only) | 4003 | `NOTIFICATION_PORT` |
| Order | 8081 | `ORDER_PORT` |
| Inventory | 8082 | `INVENTORY_PORT` |
| Payment | 8083 | `PAYMENT_PORT` |
| Frontend (Vite dev server) | 5173 | `CORS_ALLOWED_ORIGINS` |

## Verify it works

Run these after `up -d`. Kafka takes the longest (~30–40 s to report healthy).

1. **Every container is healthy** — all eight rows must say `(healthy)`:

   ```bash
   docker compose --env-file .env -f infra/docker-compose.yml ps
   ```

   Expected containers: `orderflow-postgres`, `orderflow-mongodb`, `orderflow-redis`,
   `orderflow-kafka`, `orderflow-rabbitmq`, `orderflow-kafka-ui`,
   `orderflow-mongo-express`, `orderflow-redis-commander`.

2. **Postgres created the three databases** (only on the first start with an empty volume):

   ```bash
   docker logs orderflow-postgres 2>&1 | grep orderflow-init
   docker exec orderflow-postgres psql -U postgres -c "\l" | grep _db
   ```

   You should see `order_db`, `inventory_db`, `payment_db`, each owned by its
   own `*_user`. Prove the isolation — this must be **refused**:

   ```bash
   docker exec -e PGPASSWORD=<ORDER_DB_PASSWORD> orderflow-postgres \
     psql -h 127.0.0.1 -U order_user -d inventory_db -c "select 1"
   # FATAL: permission denied for database "inventory_db"
   ```

3. **MongoDB accepts the root user** and has **no** app databases yet
   (`catalog_db` / `cart_db` appear when the services first write):

   ```bash
   docker exec orderflow-mongodb mongosh -u root -p <MONGO_ROOT_PASSWORD> \
     --authenticationDatabase admin --quiet --eval "db.adminCommand({listDatabases:1}).databases.map(d=>d.name)"
   # [ 'admin', 'config', 'local' ]
   ```

4. **Redis requires the password:**

   ```bash
   docker exec orderflow-redis env -u REDISCLI_AUTH redis-cli ping            # NOAUTH Authentication required.
   docker exec orderflow-redis redis-cli ping                                  # PONG (uses REDISCLI_AUTH inside the container)
   ```

5. **Kafka is reachable on both listeners** (no topics until
   `infra/kafka/create-topics.sh` has been run):

   ```bash
   docker exec orderflow-kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server kafka:29092 --list
   # (empty on a fresh volume; order-events, inventory-events, order-events.inventory.dlt after the script)
   docker exec orderflow-kafka grep -E '^(advertised.listeners|auto.create.topics.enable)=' /opt/kafka/config/server.properties
   # advertised.listeners=INTERNAL://kafka:29092,EXTERNAL://localhost:9092
   # auto.create.topics.enable=false
   ```

6. **RabbitMQ has the app user and vhost:**

   ```bash
   docker exec orderflow-rabbitmq rabbitmqctl list_users      # orderflow [administrator]
   docker exec orderflow-rabbitmq rabbitmqctl list_vhosts     # /
   ```

7. **Each UI loads in a browser:**

   | Open | You should see |
   | --- | --- |
   | <http://localhost:8090> | Kafka UI dashboard with cluster **orderflow** `Online`, 1 broker, 0 topics |
   | <http://localhost:15672> | RabbitMQ login → after login, the Overview page with node `rabbit@rabbitmq` |
   | <http://localhost:8091> | Browser basic-auth prompt → databases `admin`, `config`, `local` |
   | <http://localhost:8092> | redis-commander login form → after login, connection `local` (redis:6379, db 0), no keys |

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `required variable X is missing a value` on `up` | `.env` is missing a variable. Diff it against `.env.example`. |
| `Bind for 0.0.0.0:27017 failed: port is already allocated` (or any port) | Something on your machine already uses that port. Change the `*_PORT` variable in `.env` (and the matching `*_URI` / `*_URL` if it embeds the port). |
| Postgres starts but the databases are missing | The init script only runs on an **empty** volume. `down -v` then `up -d`. |
| `01-create-databases.sh: /usr/bin/env: 'bash\r': No such file` | The script got CRLF line endings. `.gitattributes` prevents this on checkout; if you edited it on Windows, convert it back to LF. |
| Kafka container restarts with `Invalid cluster.id` | `KAFKA_CLUSTER_ID` changed after the volume was formatted. Either restore the old id or `down -v`. |
| Kafka UI shows the cluster `Offline` | It connects over `kafka:29092`; wait for `orderflow-kafka` to be healthy, then refresh. |
| A service on the host cannot reach Kafka | Use `localhost:9092` (EXTERNAL listener). `kafka:29092` only resolves inside the Docker network. |

## Build order for the next steps

Each step is self-contained and ends with a working, verified piece:

1. ~~**Step 1 — API Gateway**~~ ✅ done (CORS, Clerk JWT verification, proxy routing, `X-User-Id`, correlation ids).
2. ~~**Step 2 — Catalog Service**~~ ✅ done (MongoDB `catalog_db`, integer money, bulk price lookup, seed data).
3. ~~**Step 3 — Cart Service**~~ ✅ done (Redis cache-aside over MongoDB `cart_db`, live prices, circuit breaker, `/snapshot`).
4. ~~**Step 4 — Inventory Service**~~ ✅ done (Spring Boot, `inventory_db`, pessimistic row locks, holds + expiry sweeper, Kafka topics + DLT).
5. **Step 5 — Payment Service** (Spring Boot, `payment_db`, Razorpay).
6. **Step 6 — Order Service** (Spring Boot, `order_db`, saga choreography).
7. **Step 7 — Notification Worker** (RabbitMQ consumer, retry + dead-letter queue).
8. **Step 8 — Wiring** (end-to-end saga, containerising the services, `depends_on` health gates).
9. **Step 9 — Frontend** (React + Vite + Clerk storefront).
