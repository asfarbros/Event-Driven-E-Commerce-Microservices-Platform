# Payment Service

**Status:** scaffold only — implemented in a later step.

| | |
|---|---|
| Stack | Java 17 · Spring Boot · Spring Data JPA · spring-kafka |
| Database | PostgreSQL `payment_db` (created by `infra/postgres/init/01-create-databases.sh`) |
| Messaging | Consumes `inventory-events`, publishes `payment-events` (Kafka) |
| External | Razorpay (order creation + webhook signature verification) |

## Environment variables (defined in root `.env`)

- `PAYMENT_SERVICE_PORT`
- `PAYMENT_DB_URL`, `PAYMENT_DB_USER`, `PAYMENT_DB_PASSWORD`
- `KAFKA_BOOTSTRAP_SERVERS`
- `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`
