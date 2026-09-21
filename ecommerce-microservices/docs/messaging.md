# Messaging — every topic and queue, as built (Step 8)

Two transports, on purpose (see [architecture.md §3](architecture.md#3-messaging-kafka-vs-rabbitmq)):
**Kafka** carries domain *events* the saga reacts to ("the order was
confirmed" — several consumer groups, replayable log); **RabbitMQ** carries
*commands* ("send this customer one e-mail" — one worker, per-message ack,
retry, dead-letter).

Both topologies are declared by idempotent scripts that run on the host
**and** as Compose init jobs (`kafka-init`, `rabbitmq-init`; the application
containers wait for them with `service_completed_successfully`). The services
declare the same objects at start-up with identical arguments, so order of
start-up does not matter.

```bash
bash infra/kafka/create-topics.sh            # create / repair; --list to describe
sh   infra/rabbitmq/declare-topology.sh      # create / repair; --list to show
./orderflow.sh topics   |   ./orderflow.sh queues
```

## Kafka

Broker: `orderflow-kafka` (KRaft, one node). `auto.create.topics.enable=false`.
Listeners: `kafka:29092` inside the Docker network, `localhost:9092` for
processes on the host. All topics: **3 partitions, replication factor 1** —
records are keyed by `orderId` so one order's events stay ordered on one
partition; 3 lets a group scale to 3 instances later; RF 1 because there is
one broker. Dead-letter topics keep the same partition count (the recoverer
preserves the source partition) and `retention.ms = 30 days`.

| Topic | Purpose | Producer | Consumer group(s) | Event types | Dead letters go to |
| --- | --- | --- | --- | --- | --- |
| `order-events` | facts about an order, keyed by `orderId` | Order (transactional outbox) | `inventory-service`, `payment-service` | `OrderCreated`, `OrderConfirmed`, `OrderCancelled` | `order-events.inventory.dlt` (Inventory's failures), `order-events.payment.dlt` (Payment's) |
| `inventory-events` | what happened to the stock hold | Inventory (best-effort after commit) | `order-service` | `InventoryReserved`, `InventoryConfirmed`, `InventoryReleased` (reason `ORDER_CANCELLED` \| `EXPLICIT_RELEASE` \| `EXPIRED`), `InventoryConfirmFailed`, `InventoryRestocked` | `inventory-events.order.dlt` |
| `payment-events` | what happened to the money | Payment (best-effort after commit) | `order-service` | `PaymentSucceeded`, `PaymentFailed`, `PaymentRefunded` | `payment-events.order.dlt` |
| `order-events.inventory.dlt` | records Inventory gave up on after 3 retries (1 s, 2 s, 4 s) or classed as malformed | Inventory's error handler | — (humans; `infra/kafka/dlt.sh`) | copies of `order-events` records + `kafka_dlt-*` headers | — |
| `order-events.payment.dlt` | same, for Payment | Payment's error handler | — | | — |
| `payment-events.order.dlt` | records Order gave up on: malformed, or `OrderNotReadyException` after retries | Order's error handler | — | | — |
| `inventory-events.order.dlt` | same, plus **`UnknownOrderException` immediately** (an event for an order Order never created — foreign/test data; not retried since Step 8) | Order's error handler | — | | — |

Record headers on every domain topic: `X-Request-Id` (the correlation id
minted at the Gateway), `X-Event-Type`, `X-Event-Id`, `X-Event-Version`,
`X-Source`, plus W3C `traceparent` when tracing is on. Each consumer
deduplicates: Order by `processed_event.event_id`, Inventory by reservation
status, Payment by refund uniqueness — so any record may be replayed safely.

### Inspecting and replaying a Kafka dead-letter topic

```bash
bash infra/kafka/dlt.sh count  inventory-events.order.dlt      # records per partition
bash infra/kafka/dlt.sh list   inventory-events.order.dlt      # key, root cause, original topic, X-Request-Id, value
bash infra/kafka/dlt.sh replay inventory-events.order.dlt      # re-publish to the ORIGINAL topic (kafka_dlt-* stripped,
                                                               # original headers kept, X-Replayed-From added)
```

Replay is safe because consumers are idempotent; what happens next is the
consumer's normal retry/dead-letter policy (a record that still cannot be
processed lands on the DLT again — you will see the count grow, since Kafka
topics are logs and nothing is deleted). Kafka UI (<http://localhost:8090>)
shows the same records with their headers under *Topics → …dlt → Messages*.

Consumer-group lag (records waiting per partition) is on the Grafana
dashboard (`kafka_consumer_fetch_manager_records_lag_max`) and via:

```bash
docker exec orderflow-kafka /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server kafka:29092 --describe --all-groups
```

## RabbitMQ

Broker: `orderflow-rabbitmq` (management UI <http://localhost:15672>,
prometheus plugin on 15692 network-internal). Names come from
`RABBITMQ_NOTIFICATION_*` in `.env`.

| Object | Kind | Purpose | Publisher | Consumer | Dead letters go to |
| --- | --- | --- | --- | --- | --- |
| `notifications` | topic exchange | notification COMMANDS | Order (outbox: `SendOrderConfirmation` on `order.confirmed`, `SendOrderCancellation` on `order.cancelled`) | — | — |
| `notification.tasks` | durable queue, bound `order.*` | the work queue; `x-dead-letter-exchange = notifications.dlx` | — | Notification worker (manual ack, prefetch `NOTIFICATION_PREFETCH`) | `notifications.dlx` on nack |
| `notification.tasks.retry.5000ms`, `.10000ms`, `.20000ms` | durable queues, `x-message-ttl`, DLX `""` → routing key `notification.tasks` | delayed retry tiers (attempt 1→2→3→4) | Notification worker (a copy with `x-attempt`) | nobody — TTL expiry returns the message to the work queue | — |
| `notifications.dlx` | topic exchange | dead-letter exchange | Notification worker (copies with `x-failure-kind/reason/details/attempts`) | — | — |
| `notification.tasks.dlq` | durable queue, bound `#` | parked commands: `unprocessable` (malformed, unknown user) or `exhausted` (4 failed attempts) | — | humans (`services/notification/scripts/dlq.mjs`) | — |

Message properties: `messageId` = `notify-<orderId>-<routingKey>` (the
worker's dedupe key, MongoDB `notification_db`), `correlationId` =
`X-Request-Id`, `type` = command type, header `X-Request-Id`, `traceparent`.

### Inspecting and replaying the RabbitMQ dead-letter queue

```bash
cd services/notification
node scripts/dlq.mjs list                                  # reason, details, attempts, when, which instance
node scripts/dlq.mjs replay [--message-id notify-…]        # back to `notifications` with the original routing key
node scripts/dlq.mjs purge --yes
node scripts/queues.mjs --watch                            # depths of work queue, retry tiers, DLQ (exact, via AMQP)
```

Or in the management UI: *Queues → notification.tasks.dlq → Get messages*
(headers show why) and *Move messages* (shovel) to `notification.tasks`.
The worker's ledger still applies on replay: a message whose `messageId` was
already sent is acked as a duplicate, never sent twice.

## Known difference: outbox vs best-effort publish

Order publishes through a **transactional outbox** (`outbox_event`, relayed
after commit, retried until the broker confirms — `OrderCreated` survived a
47 s Kafka outage with 6 relay attempts in the Step 8 chaos test). Inventory
and Payment publish **best-effort after commit**: the send is asynchronous,
`acks=all`, buffered up to `delivery.timeout.ms` (15 s); an outage longer
than that loses the event (logged as `event publish FAILED` with the ids).
Retrofitting the outbox to both was judged out of scope for Step 8. What
compensates today:

| Lost event | Effect | Compensation |
| --- | --- | --- |
| `PaymentSucceeded` | order stays `AWAITING_PAYMENT` | Order's reconciliation job asks Payment after `ORDER_RECONCILE_AFTER_MS` and confirms (`payment service reports SUCCESS (event was missed)`) — observed in chaos test 7a |
| `PaymentFailed` | order stays `AWAITING_PAYMENT` | same job: Payment reports `FAILED` → order `FAILED`, hold released via `OrderCancelled` |
| `InventoryReleased(EXPIRED)` | unpaid order not cancelled by the event | same job: abandoned after `ORDER_ABANDON_AFTER_MS` → `CANCELLED` |
| `InventoryReserved` / `Confirmed` / `Restocked` | audit note missing in `order_status_history` | none needed (informational) |
| `InventoryConfirmFailed` | order stays `CONFIRMED` although stock was not confirmed | **not compensated** — the one real gap; it needs both a Kafka outage > 15 s *and* a hold that expired between payment and confirmation |
| `PaymentRefunded` | `payment_status` stays `REFUND_PENDING` | Payment's own reconciliation retries the refund; the note in Order's history is informational |
