# Order Service

**Status:** placeholder — implemented in Step 6.

## What it will do

Creates orders from a checkout request and drives the order saga (choreography)
by publishing and consuming domain events on Kafka.

- Java 17 + Spring Boot 3.
- PostgreSQL, database **`order_db`**, dedicated user `ORDER_DB_USER`.
- Publishes to `order-events`; consumes `inventory-events` and `payment-events`
  to advance or compensate the order state.
- Enqueues notification tasks on RabbitMQ (e.g. "order confirmed").

## Owns

`order_db` — and only that. Inventory levels and payment records live in their
own services' databases; this service learns about them through events, never
by querying their tables.

## Environment variables it reads

| Variable | Purpose |
| --- | --- |
| `ORDER_PORT` | Port to listen on |
| `ORDER_DB_URL`, `ORDER_DB_USER`, `ORDER_DB_PASSWORD` | Its own PostgreSQL database |
| `KAFKA_BOOTSTRAP_SERVERS` | Kafka broker(s) |
| `KAFKA_TOPIC_ORDER_EVENTS`, `KAFKA_TOPIC_INVENTORY_EVENTS`, `KAFKA_TOPIC_PAYMENT_EVENTS` | Topic names |
| `RABBITMQ_URL`, `RABBITMQ_NOTIFICATION_EXCHANGE` | Enqueue notification tasks |
