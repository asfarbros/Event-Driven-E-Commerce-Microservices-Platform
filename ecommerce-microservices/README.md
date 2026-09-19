# OrderFlow – Event-Driven E-Commerce Microservices

A polyglot microservices platform: Node.js edge services, Spring Boot domain
services, Kafka for domain events / saga, RabbitMQ for the notification queue.

## Repository layout

```
.
├── apps/
│   └── client-ui/            React + Vite storefront (Clerk auth)
├── services/
│   ├── api-gateway/          Node · Express · Clerk JWT · http-proxy-middleware
│   ├── catalog/              Node · MongoDB (catalog_db)
│   ├── cart/                 Node · Redis cache + MongoDB (cart_db)
│   ├── order/                Spring Boot · PostgreSQL (order_db) · Kafka
│   ├── inventory/            Spring Boot · PostgreSQL (inventory_db) · Kafka
│   ├── payment/              Spring Boot · PostgreSQL (payment_db) · Razorpay   (scaffold)
│   └── notification/         Node worker · RabbitMQ consumer                    (scaffold)
├── infra/
│   ├── docker-compose.yml    All backing infrastructure + management UIs
│   └── postgres/init/        Creates order_db / inventory_db / payment_db on first start
├── .env.example              Every environment variable the system needs (committed)
└── .env                      Your local values (git-ignored)
```

### Data ownership

Each service connects **only** to its own database:

| Service   | Store                                  |
|-----------|----------------------------------------|
| catalog   | MongoDB `catalog_db`                   |
| cart      | Redis (cache) + MongoDB `cart_db`      |
| order     | PostgreSQL `order_db` (user `order_user`)         |
| inventory | PostgreSQL `inventory_db` (user `inventory_user`) |
| payment   | PostgreSQL `payment_db` (user `payment_user`)     |

The three Postgres databases live in one container but are separate databases
with separate owning users. Mongo databases are created by the apps on first
write.

## Configuration

**All** configuration comes from environment variables — nothing is hardcoded.
There is exactly one `.env` at the repo root, shared by every service:

```bash
cp .env.example .env     # then edit the values you need (Clerk keys, etc.)
```

How each runtime picks it up:

| Runtime            | Mechanism                                                        |
|--------------------|------------------------------------------------------------------|
| Docker Compose     | `--env-file .env` (see command below)                            |
| Node services      | `dotenv` loads `../../../.env` relative to `src/index.js`        |
| Spring Boot        | `spring.config.import: optional:file:../../.env[.properties]`    |
| Vite (client-ui)   | `envDir` points at the repo root; only `VITE_*` reach the browser |

When a service is later containerised, only the *values* change
(`localhost:9092` → `kafka:29092`, `localhost:5432` → `postgres:5432`, …).

## Bringing up the infrastructure

Prerequisite: Docker Desktop running.

```bash
# from the repo root
docker compose --env-file .env -f infra/docker-compose.yml up -d

# watch until every container reports (healthy)
docker compose --env-file .env -f infra/docker-compose.yml ps

# tear down (keeps data volumes)
docker compose --env-file .env -f infra/docker-compose.yml down

# tear down AND wipe all data
docker compose --env-file .env -f infra/docker-compose.yml down -v
```

Every stateful container has a healthcheck, so later steps can use
`depends_on: { condition: service_healthy }`.

### Endpoints (defaults from `.env.example`)

| Component            | Host address                 | Notes                                        |
|----------------------|------------------------------|----------------------------------------------|
| PostgreSQL           | `localhost:5432`             | superuser `postgres`; per-service users       |
| MongoDB              | `localhost:27017`            | root user, `authSource=admin`                |
| Redis                | `localhost:6379`             | password-protected                           |
| Kafka (external)     | `localhost:9092`             | in-network: `kafka:29092`; auto-create OFF   |
| RabbitMQ (AMQP)      | `localhost:5672`             | vhost `orderflow`                            |

### Management UIs

| UI                  | URL                            | Login                                   |
|---------------------|--------------------------------|-----------------------------------------|
| Kafka UI            | http://localhost:8090          | none                                    |
| RabbitMQ Management | http://localhost:15672         | `RABBITMQ_USER` / `RABBITMQ_PASSWORD`   |
| Mongo Express       | http://localhost:8091          | `MONGO_EXPRESS_USER` / `MONGO_EXPRESS_PASSWORD` |
| Redis Commander     | http://localhost:8092          | none                                    |

## Running the application services (host-run, current state)

```bash
# Node services
cd services/api-gateway && npm install && npm run dev      # :3000
cd services/catalog     && npm install && npm run dev      # :3001
cd services/cart        && npm install && npm run dev      # :3002

# Spring Boot services
cd services/order       && ./mvnw spring-boot:run          # :8080
cd services/inventory   && ./mvnw spring-boot:run          # :8081

# Frontend
cd apps/client-ui       && npm install && npm run dev      # :5173
```

Gateway routes: `/api/catalog/**` (public) · `/api/cart/**` (auth) · `/api/orders/**` (auth).
