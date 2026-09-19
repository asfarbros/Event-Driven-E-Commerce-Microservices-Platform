# Notification Worker

**Status:** scaffold only — implemented in a later step.

| | |
|---|---|
| Stack | Node.js worker (no HTTP server) |
| Messaging | Consumes the RabbitMQ `notifications` queue; failed jobs go to `notifications.retry` and, after exhausting retries, to `notifications.dlq` |
| Output | Mock email / SMS (console + log file) |

## Environment variables (defined in root `.env`)

- `RABBITMQ_URL`
- `NOTIFICATION_QUEUE`, `NOTIFICATION_RETRY_QUEUE`, `NOTIFICATION_DLQ`
- `NOTIFICATION_MAX_RETRIES`
