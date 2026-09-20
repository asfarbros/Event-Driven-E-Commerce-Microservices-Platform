# Payment Service

The single owner of money movement, and the **only** service in OrderFlow that
holds Razorpay credentials. It records every payment attempt, learns the
outcome from Razorpay, refunds when an order is cancelled, and tells the rest
of the system what happened over Kafka.

Two names, kept apart everywhere in code and docs:

- **Payment Service** — this microservice: our code, our `payment_db`.
- **Razorpay** — the external gateway that actually moves the money and runs
  the OTP / UPI-PIN screen. Its identifiers live in `razorpay*` columns.

Stack: **Java 17 · Spring Boot 3.5 · Spring Web · Spring Data JPA · PostgreSQL ·
Flyway · spring-kafka · Bean Validation · Actuator · Resilience4j
(circuit breaker) · logstash-logback-encoder**. Maven wrapper committed. Same
conventions as [`inventory`](../inventory/README.md): root `.env` loading,
fail-fast `ConfigGuard`, JSON logs, `{ error, message, requestId }` errors,
`X-Request-Id` correlation, explicit transaction boundaries, events published
only after commit, graceful shutdown. No Lombok.

**Razorpay client: plain HTTP (Spring `RestClient`), not the official Java SDK.**
The SDK hardcodes its base URL and timeouts; this service needs both from env
(`RAZORPAY_API_BASE_URL`, `RAZORPAY_TIMEOUT_MS`) to wrap every call in a
circuit breaker and to run against a fault-injection address. The four calls
used (create order, list an order's payments, refund, fetch refund) are plain
REST with Basic auth, and webhook verification is a ten-line HMAC.

Connects to PostgreSQL **`payment_db`** (as `PAYMENT_DB_USER`) and Kafka. It
never opens `order_db` or `inventory_db`: `ConfigGuard` refuses a URL naming
another database before connecting, and the database role cannot connect to
them anyway.

---

## Why payment is synchronous and user-present (India / RBI)

Indian regulation requires two-factor authentication on digital payments: the
customer must be present to enter an OTP or UPI PIN. So:

- Authorising a payment can never be a background, Kafka-driven step.
- Our system **creates** the payment synchronously (`POST /payments`, called by
  Order Service during checkout), the **browser** completes 2FA with Razorpay's
  widget directly, and the **result** reaches us asynchronously through
  Razorpay's **webhook** — the reliable source of truth. The browser callback
  is never trusted: the tab may be closed before it fires, and a browser can lie.
- We never see card numbers, UPI PINs or OTPs. Razorpay does. We orchestrate
  and record.

```
Order Service ──POST /payments──► Payment Service ──POST /orders──► Razorpay
                                        │ 201 { razorpayOrderId, keyId, amount }
Browser ◄─────── (via Order) ───────────┘
Browser ──── card / UPI + OTP ────────────────────────────────────► Razorpay
Payment Service ◄──────────── webhook payment.captured (signed) ──── Razorpay
        │  SUCCESS + Kafka PaymentSucceeded
        └── (webhook lost?) reconciliation job asks Razorpay and resolves it
```

## Money rules

- Money is **always an integer in paise** (`long amountInPaise`, `BIGINT`) —
  in the database, DTOs, JSON and events. There is no floating-point type
  anywhere in this service, on purpose (same rule as Catalog and Cart).
- **Razorpay uses the smallest unit too.** `amountInPaise` is sent to Razorpay
  *unchanged* (₹1,299.00 = `129900` in our DB = `"amount": 129900` to
  Razorpay). Nobody multiplies or divides by 100, ever.
- Razorpay's echo of the order amount and currency is compared with our row;
  a mismatch marks the payment FAILED (`gateway_amount_mismatch`). Every
  `payment.captured` webhook's amount is compared with our row too; a mismatch
  is recorded as a `FAILED` webhook and the payment is **not** marked SUCCESS.

## Secret handling

- `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` come from
  environment variables only (root `.env`, gitignored). No other service has
  them. **TEST-mode keys (`rzp_test_…`) are used for development**; a
  `rzp_live_` key is refused unless the `prod` profile is active.
- `.env.example` holds only obvious placeholders (`rzp_test_xxxx…`, `xxxx…`),
  and `ConfigGuard` refuses those placeholders at start-up so a missing real
  value fails fast instead of surfacing as a confusing 401 from Razorpay.
- Nothing logs a credential, a webhook body, an `Authorization` header or a
  card/UPI identifier. Webhook bodies are stored only after
  `razorpay/PayloadRedactor` removed `card`, `card_id`, `vpa`, `email`,
  `contact`, `customer_id`, `token_id`, `bank_account`, `acquirer_data`, …
  As a second layer, `logback-spring.xml` masks any JSON log field named like a
  secret or an instrument, and any 13–19-digit run. Verified: the full run log
  contains zero occurrences of the key secret, webhook secret, DB password,
  `Basic …` headers, test card numbers or e-mail addresses.

---

## Run it

```bash
bash infra/kafka/create-topics.sh          # once, from the project root (adds payment-events + order-events.payment.dlt)

cd services/payment
./mvnw clean package                       # → target/payment-service.jar, runs 11 unit tests
java -jar target/payment-service.jar       # PAYMENT_PORT (8083), reads ../../.env
./mvnw test                                # unit tests, no infrastructure
./mvnw test -Pit                           # 3 concurrency/idempotency tests against the real payment_db (fake gateway)

node scripts/send-webhook.mjs payment.captured --order order_… --payment pay_… --amount 129900   # signed webhook harness
node scripts/razorpay-stub.mjs             # local Razorpay TEST DOUBLE (see "Testing without a browser")
```

Needs JDK 17 (`JAVA_HOME`), PostgreSQL, Kafka with the topics created, and
real Razorpay **test** keys plus a webhook secret in `.env`. Through the
gateway every route is under `/api/payments` and needs a Clerk token — except
the webhook, see below.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `PAYMENT_PORT` | Listen port (8083) |
| `PAYMENT_DB_URL`, `PAYMENT_DB_USER`, `PAYMENT_DB_PASSWORD`, `PAYMENT_DB_NAME` | The owned database; the URL must name `PAYMENT_DB_NAME` |
| `PAYMENT_DB_POOL_SIZE`, `PAYMENT_LOCK_TIMEOUT_MS` | Pool size; `SET lock_timeout` per connection (keep ≥ `RAZORPAY_TIMEOUT_MS`, see Idempotency) |
| `PAYMENT_SHUTDOWN_TIMEOUT_MS` | Graceful-shutdown grace period |
| `PAYMENT_MAX_AMOUNT_IN_PAISE` | Sanity cap on one payment (→ 400) |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | Test-mode API key pair (dashboard → Settings → API Keys) |
| `RAZORPAY_WEBHOOK_SECRET` | The secret you choose when registering the webhook (dashboard → Settings → Webhooks); verifies every webhook's HMAC |
| `RAZORPAY_CURRENCY` | The only currency accepted (`INR`) |
| `RAZORPAY_API_BASE_URL`, `RAZORPAY_TIMEOUT_MS` | `https://api.razorpay.com/v1`; connect+read timeout per call |
| `PAYMENT_BREAKER_FAILURE_RATE_THRESHOLD`, `_SLIDING_WINDOW_SIZE`, `_MINIMUM_CALLS`, `_WAIT_OPEN_MS`, `_HALF_OPEN_CALLS` | Circuit breaker around Razorpay |
| `PAYMENT_RECONCILE_INTERVAL_MS`, `PAYMENT_RECONCILE_AFTER_MS`, `PAYMENT_ABANDON_AFTER_MS`, `PAYMENT_RECONCILE_BATCH_SIZE` | Reconciliation job |
| `KAFKA_BOOTSTRAP_SERVERS`, `KAFKA_TOPIC_ORDER_EVENTS`, `KAFKA_TOPIC_PAYMENT_EVENTS`, `KAFKA_TOPIC_ORDER_EVENTS_PAYMENT_DLT` | Consumed topic, published topic, dead-letter topic |
| `PAYMENT_KAFKA_CONSUMER_GROUP`, `PAYMENT_KAFKA_RETRY_{MAX_ATTEMPTS,INITIAL_MS,MULTIPLIER,MAX_MS}` | Consumer group and retry/backoff before dead-lettering |
| `LOG_LEVEL` | Level for `com.orderflow.payment` |

---

## Schema (Flyway `V1__payments_webhooks_refunds.sql`)

```
payment_transaction                      webhook_event (INBOX)                payment_refund
───────────────────                      ─────────────────────                ──────────────
id UUID PK (our paymentId)               id BIGSERIAL PK                      id UUID PK
order_id VARCHAR(64) UNIQUE              provider + provider_event_id UNIQUE  payment_id UUID → payment_transaction, UNIQUE
user_id                                  event_type                           amount_in_paise BIGINT > 0
amount_in_paise BIGINT > 0 (CHECK)       razorpay_order/payment/refund_id     currency
currency VARCHAR(3) ~ ^[A-Z]{3}$         order_id                             status INITIATED|PROCESSED|FAILED
status CREATED|PENDING|SUCCESS|FAILED|   processing_status PROCESSED|IGNORED| reason, razorpay_refund_id UNIQUE
       REFUND_PENDING|REFUNDED (CHECK)                     FAILED (CHECK)     last_gateway_error, gateway_attempts
razorpay_order_id UNIQUE                 processing_note                      triggered_by_event_id
razorpay_payment_id UNIQUE               payload JSONB (REDACTED)             created_by_request_id, version
failure_reason, last_gateway_error,      request_id, received_at,             created_at, updated_at
gateway_attempts, created_by_request_id  processed_at
version, created_at, updated_at
```

**Constraints — each a last line of defence**

| Constraint | Guarantees |
| --- | --- |
| `payment_order_id_unique` | one payment attempt record per order → **payment-creation idempotency** |
| `payment_amount_positive`, `payment_currency_iso4217`, `payment_status_valid` | no zero/negative charge, valid currency, valid state |
| `payment_pending_has_gateway_order` | a row past CREATED must know its Razorpay order |
| `payment_razorpay_order_unique`, `payment_razorpay_payment_unique` | a Razorpay order/payment maps to at most one of our rows |
| `webhook_provider_event_unique` | one inbox row per provider event id → **webhook idempotency** |
| `refund_payment_unique` | one refund per payment → **refund idempotency** (the money-critical one) |
| `refund_razorpay_refund_unique`, `refund_amount_positive`, `refund_status_valid` | consistent refund bookkeeping |

**Indexes — each tied to a query**

| Index | Serves |
| --- | --- |
| `payment_order_id_unique` | `POST /payments` replay check, `GET /payments/{orderId}`, the refund path (keyed by orderId) |
| `payment_razorpay_order_unique` | webhook processing — Razorpay events name the *Razorpay* order id |
| `payment_razorpay_payment_unique` | refund webhooks (`payment_id`) |
| `payment_unsettled_updated_idx` (**partial**: CREATED/PENDING/REFUND_PENDING) | the reconciliation job's "unsettled and unchanged for X" scan; stays tiny as settled rows accumulate |
| `payment_user_created_idx` | support: a user's payments, newest first |
| `webhook_provider_event_unique` | the dedupe check |
| `webhook_order_received_idx` | support: every webhook for a Razorpay order in arrival order |
| `refund_payment_unique` | dedupe + transaction→refund join |
| `refund_initiated_idx` (**partial**) | refunds recorded but not yet confirmed with Razorpay |

`updated_at` is maintained by a trigger so it is right for every writer.

---

## Endpoints

The gateway strips `/api/payments`; paths below are what the service sees.
Through the gateway: `http://localhost:4000/api/payments/payments/{orderId}`.

| Method | Path | Who calls it | Description |
| --- | --- | --- | --- |
| `POST` | `/payments` | **Order Service, server-to-server** | `{ orderId, userId, amountInPaise, currency }` → **201** `{ paymentId, orderId, status: PENDING, created: true, razorpayOrderId, razorpayKeyId, amountInPaise, currency }` — what the browser needs to open the widget. **200** with `created: false` on a replay. **503 `payment_gateway_unavailable`** (row stays CREATED with `last_gateway_error`; retry later), **502 `payment_gateway_rejected`** (row FAILED with the reason; `PaymentFailed` published). |
| `POST` | `/webhooks/razorpay` | **Razorpay**, server-to-server | See Webhooks. 200 processed / ignored / duplicate; 400 `invalid_signature` / `invalid_webhook`; 5xx only when we could not accept it. |
| `GET` | `/payments/{orderId}` | Order Service, support | Full status incl. `razorpay*` ids, `failureReason`, `refund { refundId, status, razorpayRefundId, amountInPaise }`. 404 `payment_not_found`. |
| `POST` | `/payments/{orderId}/refund` | Order Service / support | `{ reason? }` → `{ outcome: REFUNDED \| REFUND_PENDING \| ALREADY_REFUNDED, payment }`. 409 `nothing_to_refund` if no money was taken. Idempotent. |
| `GET` | `/health`, `/ready` | ops | `db`, `kafka`, `razorpay` (mode, key id, breaker state, failure rate), `reconciliation` (last run, resolved). `/ready` = db **and** kafka; Razorpay is *not* required for readiness. `/actuator/health` too. |

**Why the browser must never influence the amount.** `POST /payments` is
called by Order Service with the amount it computed from Cart's priced
snapshot. We store it, create the Razorpay order with it, and Razorpay binds
that amount to the order id on *its* side. The browser only receives
`razorpayOrderId` + the public key id; whatever a tampered page shows or
submits, Razorpay charges the amount attached to the order, and our webhook
handling re-checks the captured amount against our row. A client-supplied
amount would let anyone pay 1 paisa for anything. (`TODO(auth-roles)`: restrict
`POST /payments` and `/refund` to service/admin identities once the gateway
propagates roles.)

Errors use `{ error, message, requestId[, details] }`; nothing from SQL, the
driver or Razorpay's internals reaches a client. Codes: `validation_error`,
`invalid_json`, `not_found`, `method_not_allowed`, `payment_not_found`,
`invalid_signature`, `invalid_webhook`, `nothing_to_refund`, `conflict`,
`payment_busy`, `payment_gateway_unavailable`, `payment_gateway_rejected`,
`database_unavailable`, `internal_error`.

---

## Webhooks

`POST /webhooks/razorpay` is **called by Razorpay, not by a browser**. It is
authenticated by **signature, not by Clerk JWT**: Razorpay signs the raw body
with the webhook secret (`X-Razorpay-Signature` = hex HMAC-SHA256) and sends a
unique `X-Razorpay-Event-Id`. It must therefore be exposed on a public URL
that does **not** sit behind the gateway's Clerk check — either a dedicated
public route/ingress straight to this service, or a gateway rule that
forwards `/api/payments/webhooks/razorpay` with `auth: false`. (The gateway
currently protects the whole `/api/payments` prefix; the exemption is wired
in Step 8 when services are containerised.)

Processing order, strictly (`service/WebhookService`):

1. **Verify the signature over the RAW body.** The controller binds the body
   as a plain `String` — Spring hands over the request bytes as received, with
   no JSON parsing or re-serialisation — and the HMAC is computed over exactly
   those bytes. (Re-serialising would reorder keys/whitespace and never match.)
   Invalid → `400 invalid_signature`, nothing stored, nothing logged from the body.
2. **Deduplicate**: insert into `webhook_event` keyed by the provider event id.
   The insert is flushed **inside the same transaction** that applies the
   effect, so a redelivery hits `webhook_provider_event_unique`, the whole
   transaction rolls back (no second state change, no second Kafka event) and
   we answer `200 { status: "duplicate" }` so Razorpay stops retrying.
3. **Apply** under a row lock on the payment (`FOR UPDATE`), with the amount
   checked against our row:
   `payment.captured` / `order.paid` → SUCCESS; `payment.failed` → FAILED +
   `failureReason`; `refund.processed` → REFUNDED; `refund.failed` → refund
   FAILED, payment back to SUCCESS. Unknown types → recorded as IGNORED.
4. **Publish** the Kafka event — after commit only.

A transient failure (database down) rolls everything back and answers 5xx,
so Razorpay retries and the retry is processed as a first delivery. Business
no-ops (unknown Razorpay order, already settled) answer 200 IGNORED.

### Testing webhooks locally — two paths

**A. Signed harness (no tunnel, no external calls).** `scripts/send-webhook.mjs`
builds a Razorpay-shaped body, signs it exactly like Razorpay
(HMAC-SHA256 with `RAZORPAY_WEBHOOK_SECRET` from `.env`) and posts it:

```bash
node scripts/send-webhook.mjs payment.captured --order <razorpayOrderId> --payment pay_TEST1 --amount 129900 --order-id ord-1
node scripts/send-webhook.mjs payment.captured --order <razorpayOrderId> --payment pay_TEST1 --amount 129900 --event-id evt_1 --repeat 2   # 2nd = duplicate
node scripts/send-webhook.mjs payment.failed   --order <razorpayOrderId> --payment pay_TEST2 --amount 129900 --reason "Card declined"
node scripts/send-webhook.mjs payment.captured --order … --bad-signature                                                          # → 400
```

**B. Real Razorpay webhooks through a tunnel.** Razorpay cannot reach
`localhost`, so expose the port with a tunnelling tool, e.g.
`ngrok http 8083` (or `cloudflared tunnel --url http://localhost:8083`), then
in the Razorpay dashboard → *Settings → Webhooks → Add New Webhook*: URL
`https://<your-tunnel>/webhooks/razorpay`, **secret = the value of
`RAZORPAY_WEBHOOK_SECRET`** in your `.env`, events `payment.captured`,
`payment.failed`, `order.paid`, `refund.processed`, `refund.failed`. Pay a
test order (test card `4111 1111 1111 1111`, any future expiry/CVV, then
"Success" on the test OTP page) and watch the service log the webhook. The
dashboard's webhook page also lets you resend a delivery — a good way to
demonstrate the duplicate path against real Razorpay traffic.

### Testing without a browser (test double)

`scripts/razorpay-stub.mjs` is a local **Razorpay test double** — it speaks the
subset of Razorpay's REST API this service uses and adds control endpoints
(`/_stub/capture` "the user paid", `/_stub/fault` down/timeout/lost-response).
It is *not* Razorpay; use it only for a verification run:

```bash
node scripts/razorpay-stub.mjs &
RAZORPAY_API_BASE_URL=http://localhost:9095/v1 RAZORPAY_KEY_ID=rzp_test_STUBSTUBSTUB00 RAZORPAY_KEY_SECRET=stub-secret-not-a-real-secret \
PAYMENT_RECONCILE_INTERVAL_MS=5000 PAYMENT_RECONCILE_AFTER_MS=5000 java -jar target/payment-service.jar
```

---

## Kafka

### Publishes `payment-events` — THE CONTRACT for Order Service (Step 6)

Record **key** = `orderId`. **Headers** (identical layout to inventory-events):

| Header | Value |
| --- | --- |
| `X-Request-Id` | Correlation id of the originating request / webhook / reconciliation run |
| `X-Event-Type` | `PaymentSucceeded` \| `PaymentFailed` \| `PaymentRefunded` |
| `X-Event-Id` | UUID, unique per event — a consumer's dedupe key |
| `X-Event-Version` | `1` |
| `X-Source` | `payment` |
| `Content-Type` | `application/json` |

**Value** (`service/PaymentEvent`; absent fields are omitted, never `null`):

```json
{
  "eventId":           "5c8ca28a-c9f3-49cb-8678-ab0959c73990",
  "eventType":         "PaymentSucceeded",
  "version":           1,
  "source":            "payment",
  "occurredAt":        "2026-09-20T04:18:03.801Z",
  "correlationId":     "webhook-evt_cap_1-1",
  "orderId":           "ord-P1",
  "paymentId":         "88922258-14af-4f8d-b55c-4df31c1f02b8",
  "userId":            "user_3JYk…",
  "amountInPaise":     129900,
  "currency":          "INR",
  "razorpayOrderId":   "order_Te9jhkDjHvZDui",
  "razorpayPaymentId": "pay_…",
  "razorpayRefundId":  "rfnd_…",           // PaymentRefunded only
  "failureReason":     "Card declined…"    // PaymentFailed only
}
```

| `eventType` | When |
| --- | --- |
| `PaymentSucceeded` | payment captured — by webhook, or found by reconciliation |
| `PaymentFailed` | attempt failed (webhook), Razorpay rejected the order (`POST /payments`), or abandoned (reconciliation) |
| `PaymentRefunded` | refund processed — by the refund call, a `refund.processed` webhook, or reconciliation |

Sends are asynchronous (`acks=all`, idempotent producer) and never block a
response; failures are logged with every id needed to replay. (A transactional
outbox is the noted follow-up, as for Inventory.)

### Consumes `order-events`

Same envelope Inventory consumes: `{ eventType, version, eventId, orderId,
occurredAt }` + `X-Request-Id` header. **`OrderCancelled` for a PAID order →
refund** (the compensating action for money): the refund row is inserted and
committed → Razorpay `POST /payments/{id}/refund` → REFUNDED (or
REFUND_PENDING until `refund.processed`). For an unpaid order it is a logged
no-op. Consumer group `PAYMENT_KAFKA_CONSUMER_GROUP`, manual acks after the
service call, retry with exponential backoff (`PAYMENT_KAFKA_RETRY_*`) then the
**dead-letter topic `order-events.payment.dlt`** — malformed records go there
immediately; Razorpay-unavailable is retried (safe: a retry can only *resume*
the one refund row, never start another). Each consumer of `order-events` has
its own DLT.

---

## Idempotency — three levels, and the constraint behind each

| Level | Mechanism | Database enforcement |
| --- | --- | --- |
| **Payment creation** (`POST /payments` retried) | The row is written first; an existing row is returned (`created: false`). The Razorpay order is created **under the row lock** (`FOR UPDATE`, held for one gateway round trip, bounded by `RAZORPAY_TIMEOUT_MS`; `PAYMENT_LOCK_TIMEOUT_MS` ≥ that), so a concurrent retry waits, then sees the Razorpay order id the first call committed. A row left CREATED by a gateway outage gets the Razorpay step retried — still one row, at most one Razorpay order. | `payment_order_id_unique` — a losing concurrent insert rolls back and returns the winner. Verified: 30 concurrent creates → 1 row, 1 gateway order. |
| **Webhook processing** (Razorpay redeliveries) | Inbox insert + state change in ONE transaction; the duplicate rolls back before anything is applied; 200 "duplicate". | `webhook_provider_event_unique`. Verified: same event ×2 → 1 inbox row, 1 update, 1 Kafka event; 20 *simultaneous* deliveries → 1 processed, 19 duplicate. |
| **Refunds** (same `OrderCancelled` twice, or a new one later) | Status checked under the row lock; SUCCESS is the only state that starts a refund; REFUND_PENDING resumes; REFUNDED is a no-op. Before calling Razorpay, refunds Razorpay already holds for the payment are adopted (lost-response guard). Only the call that performs a transition publishes. | `refund_payment_unique` — the refund row is **committed before Razorpay is called**, so a second cancellation cannot insert a second row and therefore cannot trigger a second refund, no matter when it arrives. Verified: 3 deliveries → 1 refund row, 1 gateway refund, 1 event; 30 concurrent cancellations → 1 gateway refund; a hand-written second row is rejected by the constraint. |

---

## Resilience

- **Timeout + circuit breaker** (`razorpay/RazorpayGateway`, Resilience4j):
  every Razorpay call has a `RAZORPAY_TIMEOUT_MS` connect/read timeout and
  runs inside one breaker configured from `PAYMENT_BREAKER_*`. Timeouts and
  5xx count as failures; 4xx (`Rejected`) do not — Razorpay is up, our request
  was wrong. State transitions are logged at WARN and shown in `/health`.
  Measured: 5.04 s timeouts → OPEN after the 4th failure → 27 ms fast-fails →
  HALF_OPEN after 10 s → CLOSED on the first good calls.
- **No ambiguous rows.** If Razorpay is unreachable while creating a payment,
  the row stays CREATED with `last_gateway_error` and `gateway_attempts`, the
  caller gets `503 payment_gateway_unavailable` and may retry; if Razorpay
  rejects it, the row is FAILED with the reason and `PaymentFailed` is
  published. Same for refunds (`payment_refund.last_gateway_error`).
- **Reconciliation job** (`service/ReconciliationJob`, every
  `PAYMENT_RECONCILE_INTERVAL_MS`): rows unchanged for
  `PAYMENT_RECONCILE_AFTER_MS` in CREATED / PENDING / REFUND_PENDING are
  re-checked with Razorpay, each in its own `FOR UPDATE SKIP LOCKED`
  transaction. CREATED → look the order up by receipt (= our orderId), attach
  it, or FAIL it after `PAYMENT_ABANDON_AFTER_MS`. PENDING → list the order's
  payments: captured with our amount → SUCCESS + `PaymentSucceeded`; nothing
  captured after the abandon window → FAILED (`abandoned`) + `PaymentFailed`;
  otherwise wait (the user may be on the OTP screen). REFUND_PENDING → resume
  or confirm the refund. **Why it is necessary even with webhooks:** a webhook
  is one best-effort HTTP call; it is lost when we are restarting, the tunnel
  drops it, our database is briefly down (we answered 500 until Razorpay's
  retries ran out), or it was never configured for that environment — yet the
  money has moved. Without this job the payment would sit in PENDING forever,
  Inventory's hold would expire, and the customer would have paid for nothing.

## Graceful shutdown

`server.shutdown: graceful` + `spring.lifecycle.timeout-per-shutdown-phase =
PAYMENT_SHUTDOWN_TIMEOUT_MS`: on SIGTERM/SIGINT the HTTP connector stops
accepting, in-flight requests and transactions finish, the Kafka listener
completes the record in hand and closes the consumer, the scheduler drains.

## Layout

```
services/payment/
├── pom.xml, mvnw, mvnw.cmd, .mvn/wrapper/
├── scripts/
│   ├── send-webhook.mjs          signed webhook harness (path A)
│   └── razorpay-stub.mjs         local Razorpay test double for browser-less verification
└── src/main/
    ├── resources/  application.yml · logback-spring.xml (with masking) · META-INF/spring.factories · db/migration/V1__…sql
    └── java/com/orderflow/payment/
        ├── config/      DotenvEnvironmentPostProcessor, ConfigGuard (+ analyzer), PaymentProperties, StartupReporter, ClockConfig
        ├── correlation/ Correlation
        ├── domain/      PaymentTransaction, PaymentStatus, WebhookEvent, PaymentRefund, repositories (FOR UPDATE / SKIP LOCKED)
        ├── razorpay/    RazorpayGateway (RestClient + breaker), RazorpayExceptions, WebhookSignature, PayloadRedactor
        ├── service/     PaymentService (create/refund), WebhookService, ReconciliationJob, PaymentEvent (contract), PaymentView
        ├── kafka/       KafkaPaymentEventPublisher, OrderEventsListener, KafkaConsumerConfig (retry + DLT)
        ├── health/      DatabaseHealth, KafkaHealth
        └── web/         PaymentController, WebhookController, HealthController, ApiExceptionHandler, CorrelationFilter, ApiDtos
```
