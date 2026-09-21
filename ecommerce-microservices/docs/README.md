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
| Notification Worker | Node.js (headless) | MongoDB `notification_db` (dedupe ledger only) | RabbitMQ consumer (retry queues + DLQ), SMTP/Mailpit or console | `NOTIFICATION_PORT` = 4003 (health only) |
| Storefront (`apps/client-ui`) | React 19 + Vite + Tailwind v4 + Clerk, served by nginx | — (browser talks only to the Gateway) | Gateway (HTTP), Clerk, Razorpay Checkout | `CLIENT_UI_PORT` = 5173 |

> **Progress:** all nine steps are done. `./orderflow.sh up` brings up the infrastructure,
> the seven services, the observability stack and the storefront; `./orderflow.sh smoke`
> proves the happy path; the storefront is documented in [`apps/client-ui/README.md`](../apps/client-ui/README.md).

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
│   ├── kafka/create-topics.sh    # creates the Kafka topics (auto-creation is off)
│   └── rabbitmq/declare-topology.sh  # notification exchange, queue, DLX, DLQ
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

## Running everything — one command (Step 8)

All commands run from the **project root** (the folder containing `.env`).

First time only:

```bash
cp .env.example .env      # then edit the change_me_* values, the Clerk keys, the Razorpay keys and SMOKE_CLERK_USER_ID
```

Then:

```bash
./orderflow.sh up          # builds the 7 service images, starts infra + messaging setup + services + observability,
                           # waits until every container is healthy, seeds catalog + inventory (idempotent)
./orderflow.sh smoke       # happy path through the gateway, 12 checks, pass/fail   (needs node >= 20 on the host)
./orderflow.sh ps | logs order | stats | topics | queues
./orderflow.sh down        # keep data        ./orderflow.sh down -v   # wipe volumes (cold start next time)
```

Measured on the Step 8 laptop: cold start from empty volumes to
"all healthy + seeded" in **94 s**; the smoke test passes in ~10 s right
after. Flags: `--no-build` (reuse images), `--no-observability` (no
Prometheus/Grafana/Jaeger, tracing off), `--debug-ports` (publish the internal
services on the host — dev only, see below).

Under the hood it is three Compose files layered together, which you can also
run by hand:

```bash
docker compose --env-file .env -f infra/docker-compose.yml -f infra/docker-compose.services.yml \
               -f infra/docker-compose.observability.yml up -d --build
```

| File | Contains |
| --- | --- |
| `infra/docker-compose.yml` | Postgres, MongoDB, Redis, Kafka, RabbitMQ, Mailpit + the management UIs (usable alone for host-mode development, as in Steps 1–7) |
| `infra/docker-compose.services.yml` | `kafka-init` / `rabbitmq-init` (the declarative topology jobs) + the 7 services, with `depends_on: service_healthy`, healthchecks, memory limits |
| `infra/docker-compose.observability.yml` | Prometheus, Grafana (provisioned), Jaeger |
| `infra/docker-compose.debug-ports.yml` | optional: publishes catalog/cart/order/inventory/payment/notification ports on the host |

### Host vs container addresses

Every service reads the same root `.env`. Its addresses are the
**host-published** ones (`localhost:5432`, `localhost:9092`,
`http://localhost:4001`, …), so `npm start` / `java -jar` on the host keep
working. In containers the same things live at their **service names and
internal ports** (`postgres:5432`, `kafka:29092`, `mongodb:27017`,
`redis:6379`, `rabbitmq:5672`, `http://catalog:4001`, `mailpit:1025`), so
`docker-compose.services.yml` overrides only the address-bearing variables
per container — rebuilt from the `.env` pieces (user, password, db name), so no
credential is repeated. Kafka's two listeners (`localhost:9092` / `kafka:29092`)
exist exactly for this. Only the **API Gateway** publishes a host port
(`GATEWAY_PORT`); everything else is reachable on the Docker network only —
add `--debug-ports` to reach a service directly (this also removes the
"only the gateway can inject `X-User-Id`" guarantee on your laptop, so never
in a deployment).

Seeding: `./orderflow.sh seed` runs Catalog's `scripts/seed.js` and
Inventory's `seed` profile inside their containers; both are idempotent
(upsert by SKU / product id). `up` runs it automatically.

## Running the infrastructure only (host-mode development)

Start the backing services and run the application services on the host,
exactly as in Steps 1–7:

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

## Running the Payment Service (Step 5)

The only service that holds Razorpay credentials. Needs JDK 17, PostgreSQL
(`payment_db`), Kafka with the topics created, and **Razorpay TEST-mode keys**
(`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` from dashboard.razorpay.com →
Settings → API Keys) plus a `RAZORPAY_WEBHOOK_SECRET` of your choosing in `.env`
— the placeholders are refused at start-up.

```bash
bash infra/kafka/create-topics.sh      # once (now also payment-events + order-events.payment.dlt)

cd services/payment
./mvnw clean package                   # builds target/payment-service.jar, runs 11 unit tests
java -jar target/payment-service.jar   # http://localhost:8083  (PAYMENT_PORT) — reads ../../.env
./mvnw test -Pit                       # 3 idempotency/concurrency tests against the real payment_db
node scripts/send-webhook.mjs payment.captured --order <razorpayOrderId> --payment pay_TEST --amount 129900   # signed webhook, no tunnel
```

Synchronous, user-present payment creation (India/RBI 2FA), webhooks as the
source of truth with an idempotent inbox, refunds on `OrderCancelled` that
cannot double-refund, a circuit breaker around Razorpay, a reconciliation
job for missed webhooks, and the `payment-events` contract — all in
[services/payment/README.md](../services/payment/README.md). Razorpay cannot
reach localhost: that README covers both the signed-harness path and the
tunnel (ngrok) path for real webhooks.

## Running the Order Service (Step 6)

The orchestrator. Needs everything above running (Catalog, Cart, Inventory,
Payment on their `*_SERVICE_URL`s), PostgreSQL (`order_db`), Kafka and RabbitMQ:

```bash
bash infra/kafka/create-topics.sh          # once (adds payment-events.order.dlt, inventory-events.order.dlt)
bash infra/rabbitmq/declare-topology.sh    # once (the service also declares it on start-up)

cd services/order
./mvnw clean package                       # target/order-service.jar, 11 unit tests
java -jar target/order-service.jar         # http://localhost:8081  (ORDER_PORT)
./mvnw test -Pit                           # 3 saga-safety tests against the real order_db (fake downstream clients)
```

Checkout through the gateway: add to the cart, then `POST /api/orders/` with a
Clerk token and an `Idempotency-Key`; the response carries what the browser
needs to open Razorpay. The synchronous/asynchronous split, the state machine,
compensation matrix, transactional outbox, circuit breakers and the
notification command contract are in
[services/order/README.md](../services/order/README.md).

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
| Mailpit (SMTP test inbox for the Notification Worker) | <http://localhost:8093> · SMTP on 1025 | `MAILPIT_UI_PORT`, `MAILPIT_SMTP_PORT` | none |

### Observability (Step 8 — `infra/docker-compose.observability.yml`)

| UI | URL | `.env` variables | Login |
| --- | --- | --- | --- |
| Storefront (Step 9) — browse, cart, checkout with Razorpay test mode, live order status | <http://localhost:5173> | `CLIENT_UI_PORT` | Clerk sign-in (your test user) |
| Grafana — dashboard *OrderFlow — Overview* (request rate, 5xx rate, p50/p95 latency per service, Kafka consumer lag, RabbitMQ queue depth, notification outcomes, circuit breakers, memory) | <http://localhost:3001> | `GRAFANA_PORT` | `GRAFANA_ADMIN_USER` / `GRAFANA_ADMIN_PASSWORD` |
| Prometheus — 10 scrape targets (7 services, RabbitMQ ×2, itself) | <http://localhost:9090/targets> | `PROMETHEUS_PORT` | none |
| Jaeger — distributed traces (OpenTelemetry, OTLP) | <http://localhost:16686> | `JAEGER_UI_PORT` | none |

Metrics: the Node services expose `GET /metrics` (prom-client, with an
`http_server_requests_seconds` histogram named and labelled like Spring
Boot's so one query covers all seven); the Java services expose
`/actuator/prometheus` (Micrometer); RabbitMQ its prometheus plugin
(`/metrics` + `/metrics/detailed?family=queue_coarse_metrics` for per-queue
depth). Tracing: the Java services run the OpenTelemetry Java agent (shipped in
the image, enabled by `JAVA_TOOL_OPTIONS=-javaagent:…` in Compose), the Node
services `@opentelemetry/auto-instrumentations-node/register`; both export
OTLP/HTTP to `jaeger:4318` and propagate W3C `traceparent` through HTTP,
Kafka record headers and AMQP headers. Order stores the `traceparent` in its
outbox row and restores it when the relay publishes, so a trace does not end
at the database. Everything is provisioned from files under `infra/` — a
`down -v` / `up` comes back identical, nothing to click.

### Application services (in containers only the gateway is published; the others need `--debug-ports`)

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

With the full stack (`./orderflow.sh up`), the fastest check is the smoke test
and then the scenario scripts, all through the gateway with a real Clerk token:

```bash
./orderflow.sh smoke                          # 12 checks: health → token → browse → cart → checkout → webhook → CONFIRMED → stock → payment → notification
node scripts/scenarios.mjs happy|oos|payfail|abandon|cancel|concurrency   # Part E scenarios 1–6, with database dumps
node scripts/chaos.mjs kafka|rabbitmq|inventory                            # scenario 7: stop a dependency mid-checkout
```

Scenario 5 needs Payment pointed at the Razorpay test double (a refund must
reference a payment the provider knows): run `services/payment/scripts/razorpay-stub.mjs`
on the network and pass `--stub http://localhost:9095` — see the script headers.

The checks below are for the infrastructure-only start.


Run these after `up -d`. Kafka takes the longest (~30–40 s to report healthy).

1. **Every container is healthy** — all nine rows must say `(healthy)`:

   ```bash
   docker compose --env-file .env -f infra/docker-compose.yml ps
   ```

   Expected containers: `orderflow-postgres`, `orderflow-mongodb`, `orderflow-redis`,
   `orderflow-kafka`, `orderflow-rabbitmq`, `orderflow-kafka-ui`,
   `orderflow-mongo-express`, `orderflow-redis-commander`, `orderflow-mailpit`.

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
   # (empty on a fresh volume; order-events, inventory-events, payment-events + four .dlt topics after the script)
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
| `./orderflow.sh up` waits forever on `orderflow-jaeger` | Jaeger v2's readiness is `GET :13133/status` (healthcheckv2), not `/`. Fixed in the compose file; if you change the Jaeger version, check the healthcheck path. |
| `bash infra/kafka/create-topics.sh` → `.env: line N: syntax error near unexpected token 'newline'` | A `.env` value contains shell metacharacters (`<`, `>`, spaces) unquoted. Quote it: `NOTIFICATION_FROM="OrderFlow <no-reply@…>"`. dotenv, Compose and the Java loader all strip double quotes. |
| Order's consumer takes minutes to "wake up" / `inventory-events` lag stays > 0 | Records for orders Order never created (test scripts, another environment) were retried in place (1 s + 2 s + 4 s each) and blocked the partition. Since Step 8 `UnknownOrderException` is not retried — straight to `inventory-events.order.dlt`. Inspect with `bash infra/kafka/dlt.sh list inventory-events.order.dlt`. |
| Notification worker logs `clerk user lookup failed: ECONNRESET` / `TimeoutError` and retries | The TLS handshake to `api.clerk.com` from Docker Desktop's NAT (and from this laptop in general) is slow (3–4 s) and occasionally reset. The worker retries a reset in-process, then through its 5 s / 10 s / 20 s queue backoff; `NOTIFICATION_CLERK_TIMEOUT_MS` is 10 s for that reason. `NOTIFICATION_RECIPIENT_SOURCE=static` avoids Clerk entirely. |
| The smoke test / scenarios fail with `fetch failed … ECONNRESET` on the Clerk call | Same network issue on the host; the scripts retry up to 4 times. Re-run. |
| `docker compose build` fails with `failed to fetch oauth token … forcibly closed` | Docker Hub's auth endpoint reset the connection (same laptop network issue). Re-run; the layers are cached. |
| RabbitMQ management UI / API shows a queue at 0 messages while `checkQueue` says 1 | The management API's per-queue counters are sampled and lag by several seconds. The worker's `scripts/queues.mjs` and `dlq.mjs` read exact counts over AMQP. |
| A service container is `unhealthy` after a dependency outage (e.g. Order after Kafka was stopped) | `/ready` returns 503 while a required dependency is down and the container stays running (Docker does not restart on unhealthy); it recovers by itself when the dependency returns (Kafka clients, Spring AMQP and the worker all reconnect). |
| Sending SIGTERM to a Node process on Windows kills it instantly (no graceful shutdown) | Windows cannot deliver SIGTERM to another process. Ctrl-C (SIGINT) in its terminal works, and in containers (`docker stop`) SIGTERM works normally. |
| Java images are ~460 MB, Node images ~320 MB | The JRE base is ~200 MB; the OpenTelemetry auto-instrumentation bundle adds ~150 MB of `node_modules` to each Node image. The app layers themselves are tiny (Java app layer 0.8 MB) and cache well. |
| The storefront shows "We can’t reach the store right now" although the gateway is up | The page's origin is not in `CORS_ALLOWED_ORIGINS` (e.g. you opened `http://127.0.0.1:5173` or `vite preview` on 4173). Add the origin to `.env` and restart the gateway. |
| Checkout: `Idempotency-Key` blocked by CORS | The gateway must list it in its CORS `allowedHeaders` (it does since Step 9); a browser preflight fails silently otherwise while curl works. |
| Razorpay's payment window stays blank / never loads | Network path to Razorpay (seen on this laptop). After ~8 s the storefront shows a top-layer "Continue to your order" hatch; the order stays `AWAITING_PAYMENT` and can be paid again from the status page or cancelled. |
| Whole stack memory | ~3.0 GiB with everything running (services 1.3 GiB, infra 1.2 GiB — Kafka alone ~540 MiB, observability 0.3 GiB, UIs 0.5 GiB). Comfortable on 16 GB; on 8 GB use `--no-observability` and stop the UI containers. |

## Build order for the next steps

Each step is self-contained and ends with a working, verified piece:

1. ~~**Step 1 — API Gateway**~~ ✅ done (CORS, Clerk JWT verification, proxy routing, `X-User-Id`, correlation ids).
2. ~~**Step 2 — Catalog Service**~~ ✅ done (MongoDB `catalog_db`, integer money, bulk price lookup, seed data).
3. ~~**Step 3 — Cart Service**~~ ✅ done (Redis cache-aside over MongoDB `cart_db`, live prices, circuit breaker, `/snapshot`).
4. ~~**Step 4 — Inventory Service**~~ ✅ done (Spring Boot, `inventory_db`, pessimistic row locks, holds + expiry sweeper, Kafka topics + DLT).
5. ~~**Step 5 — Payment Service**~~ ✅ done (Spring Boot, `payment_db`, Razorpay test mode, signed webhooks, refunds, reconciliation).
6. ~~**Step 6 — Order Service**~~ ✅ done (Spring Boot, `order_db`, sync/async checkout, outbox, breakers, RabbitMQ commands).
7. ~~**Step 7 — Notification Worker**~~ ✅ done (headless RabbitMQ consumer, manual acks + prefetch, tiered retry queues with backoff, DLQ with reasons + replay, MongoDB dedupe ledger, console/SMTP channels, Mailpit).
8. ~~**Step 8 — Wiring**~~ ✅ done (7 Dockerfiles, layered Compose with health-gated start-up and init jobs, `./orderflow.sh up`/`smoke`, Prometheus + Grafana + Jaeger with connected traces across Kafka/RabbitMQ, 8 scenarios incl. chaos and cold start, Kafka DLT tooling).
9. ~~**Step 9 — Frontend**~~ ✅ done (React 19 + Vite + Tailwind v4 + Clerk storefront in `apps/client-ui`: tokens + primitives + style guide, catalogue, cart with degraded mode, Razorpay checkout with idempotency keys, polling status page with the saga timeline, nginx container in Compose).
