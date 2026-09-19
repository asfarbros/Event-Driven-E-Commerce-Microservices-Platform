# Payment Service

**Status:** placeholder — implemented in Step 5.

## What it will do

Creates Razorpay orders, verifies payment signatures / webhooks, and records the
outcome as part of the order saga.

- Java 17 + Spring Boot 3.
- PostgreSQL, database **`payment_db`**, dedicated user `PAYMENT_DB_USER`.
- Razorpay integration (`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, webhook secret).
- Consumes `inventory-events` (`StockReserved` → start payment).
- Publishes `payment-events` (`PaymentSucceeded`, `PaymentFailed`).

## Owns

`payment_db` — and only that. Card / gateway details never leave Razorpay; this
service stores only references, amounts and status.

## Environment variables it reads

| Variable | Purpose |
| --- | --- |
| `PAYMENT_PORT` | Port to listen on |
| `PAYMENT_DB_URL`, `PAYMENT_DB_USER`, `PAYMENT_DB_PASSWORD` | Its own PostgreSQL database |
| `KAFKA_BOOTSTRAP_SERVERS` | Kafka broker(s) |
| `KAFKA_TOPIC_INVENTORY_EVENTS`, `KAFKA_TOPIC_PAYMENT_EVENTS` | Topic names |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_CURRENCY` | Razorpay |
