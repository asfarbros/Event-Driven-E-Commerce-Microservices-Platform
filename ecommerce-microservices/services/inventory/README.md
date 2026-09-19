# Inventory Service

**Status:** placeholder — implemented in Step 4.

## What it will do

Tracks stock per product and reserves / releases it as part of the order saga.

- Java 17 + Spring Boot 3.
- PostgreSQL, database **`inventory_db`**, dedicated user `INVENTORY_DB_USER`.
- Consumes `order-events` (reserve stock on `OrderCreated`, release on
  `OrderCancelled` / `PaymentFailed`).
- Publishes `inventory-events` (`StockReserved`, `StockRejected`, `StockReleased`).

## Owns

`inventory_db` — and only that.

## Environment variables it reads

| Variable | Purpose |
| --- | --- |
| `INVENTORY_PORT` | Port to listen on |
| `INVENTORY_DB_URL`, `INVENTORY_DB_USER`, `INVENTORY_DB_PASSWORD` | Its own PostgreSQL database |
| `KAFKA_BOOTSTRAP_SERVERS` | Kafka broker(s) |
| `KAFKA_TOPIC_ORDER_EVENTS`, `KAFKA_TOPIC_INVENTORY_EVENTS` | Topic names |
