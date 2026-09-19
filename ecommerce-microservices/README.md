# OrderFlow

Event-driven e-commerce backend built as microservices: Node.js gateway + catalog +
cart, Spring Boot order / inventory / payment, Kafka for domain events and the
checkout saga, RabbitMQ for notifications, one database per service.

**Start here → [docs/README.md](docs/README.md)** — prerequisites, how to run the
infrastructure, every port and UI login, and a verification checklist.
Design rules live in [docs/architecture.md](docs/architecture.md).

Quick start:

```bash
cp .env.example .env                                              # first time only
docker compose --env-file .env -f infra/docker-compose.yml up -d
docker compose --env-file .env -f infra/docker-compose.yml ps     # wait for 8 × (healthy)
```
