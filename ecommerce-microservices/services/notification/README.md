# Notification Worker

**Status:** placeholder — implemented in Step 7.

## What it will do

A background worker (no public HTTP API) that consumes notification tasks from
RabbitMQ and sends them (email / log / push — pluggable).

- Node.js.
- Consumes `RABBITMQ_NOTIFICATION_QUEUE`.
- Failed tasks are retried with a delay up to `RABBITMQ_NOTIFICATION_MAX_RETRIES`
  times, then parked in the dead-letter queue `RABBITMQ_NOTIFICATION_DLQ` for
  inspection in the RabbitMQ management UI.

## Owns

No database. It is a pure consumer; state lives in the queue.

## Environment variables it reads

| Variable | Purpose |
| --- | --- |
| `NOTIFICATION_PORT` | Optional health/metrics port |
| `RABBITMQ_URL` | Broker connection |
| `RABBITMQ_NOTIFICATION_EXCHANGE`, `RABBITMQ_NOTIFICATION_QUEUE`, `RABBITMQ_NOTIFICATION_DLX`, `RABBITMQ_NOTIFICATION_DLQ` | Topology names |
| `RABBITMQ_NOTIFICATION_MAX_RETRIES`, `RABBITMQ_NOTIFICATION_RETRY_DELAY_MS` | Retry policy |
| `LOG_LEVEL`, `NODE_ENV` | Runtime behaviour |
