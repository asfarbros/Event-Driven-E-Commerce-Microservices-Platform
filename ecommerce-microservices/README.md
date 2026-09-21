# OrderFlow

Event-driven e-commerce backend built as microservices: Node.js gateway + catalog +
cart, Spring Boot order / inventory / payment, Kafka for domain events and the
checkout saga, RabbitMQ for notifications, one database per service.

**Start here → [docs/README.md](docs/README.md)** — prerequisites, how to run the
infrastructure, every port and UI login, and a verification checklist.
Design rules live in [docs/architecture.md](docs/architecture.md).

Quick start (everything in containers — Step 8):

```bash
cp .env.example .env        # first time only: fill in the change_me_* values, Clerk + Razorpay keys, SMOKE_CLERK_USER_ID
./orderflow.sh up           # infra + messaging topology + 7 services + Prometheus/Grafana/Jaeger, health-gated, seeded
./orderflow.sh smoke        # browse → cart → checkout → signed payment webhook → CONFIRMED → stock → notification
```

Then open Grafana (<http://localhost:3001>), Jaeger (<http://localhost:16686>)
and the gateway (<http://localhost:4000/health>). Infrastructure-only mode for
host development: `docker compose --env-file .env -f infra/docker-compose.yml up -d`.
