-- =============================================================================
-- V1 — payment transactions, the webhook inbox, and refunds
-- =============================================================================
-- Runs once, via Flyway, inside payment_db as PAYMENT_DB_USER. Hibernate is set
-- to ddl-auto=validate: this file is the only source of schema. Never edit an
-- applied migration; add V2__*.sql.
--
-- Naming: "Payment Service" = this service and these tables. "Razorpay" = the
-- external gateway that actually moves money; its identifiers are stored in
-- columns prefixed razorpay_*.
--
-- MONEY is always an integer number of PAISE (BIGINT). Razorpay's API also
-- takes the smallest currency unit, so the value in amount_in_paise is sent to
-- Razorpay AS IS — never multiplied or divided by 100 anywhere.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- payment_transaction — exactly one row per order
-- -----------------------------------------------------------------------------
-- Lifecycle:
--   CREATED         row written; Razorpay order not (yet) created
--   PENDING         Razorpay order exists; waiting for the user to finish 2FA
--   SUCCESS         payment captured (webhook payment.captured / reconciliation)
--   FAILED          payment failed / abandoned / gateway rejected the order
--   REFUND_PENDING  refund requested with Razorpay, not yet processed
--   REFUNDED        refund processed
CREATE TABLE payment_transaction (
    id                    UUID          PRIMARY KEY,
    order_id              VARCHAR(64)   NOT NULL,
    user_id               VARCHAR(128)  NOT NULL,
    amount_in_paise       BIGINT        NOT NULL,
    currency              VARCHAR(3)    NOT NULL,
    status                VARCHAR(20)   NOT NULL,
    razorpay_order_id     VARCHAR(64),
    razorpay_payment_id   VARCHAR(64),
    failure_reason        VARCHAR(500),
    -- Last error talking to Razorpay for THIS row, so a stuck row always says why.
    last_gateway_error    VARCHAR(500),
    gateway_attempts      INTEGER       NOT NULL DEFAULT 0,
    created_by_request_id VARCHAR(128),
    version               BIGINT        NOT NULL DEFAULT 0,
    created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),

    -- LAST LINE OF DEFENCE: a zero or negative charge can never be persisted,
    -- and a currency must be an ISO-4217 code.
    CONSTRAINT payment_amount_positive    CHECK (amount_in_paise > 0),
    CONSTRAINT payment_currency_iso4217   CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT payment_status_valid       CHECK (status IN
        ('CREATED', 'PENDING', 'SUCCESS', 'FAILED', 'REFUND_PENDING', 'REFUNDED')),
    -- A row that is past CREATED must know its Razorpay order.
    CONSTRAINT payment_pending_has_gateway_order
        CHECK (status = 'CREATED' OR status = 'FAILED' OR razorpay_order_id IS NOT NULL),

    -- IDEMPOTENCY OF PAYMENT CREATION, ENFORCED BY THE DATABASE.
    -- Order Service may retry POST /payments; only ONE row can ever exist per
    -- order, so only one Razorpay order is ever created for it. A concurrent
    -- retry that loses this insert race returns the winner's row.
    CONSTRAINT payment_order_id_unique     UNIQUE (order_id),
    -- One Razorpay order / payment can belong to at most one of our rows.
    CONSTRAINT payment_razorpay_order_unique   UNIQUE (razorpay_order_id),
    CONSTRAINT payment_razorpay_payment_unique UNIQUE (razorpay_payment_id)
);

COMMENT ON TABLE  payment_transaction                 IS 'One payment attempt record per order. Amounts are integer paise.';
COMMENT ON COLUMN payment_transaction.amount_in_paise IS 'Integer paise (INR 1,299.00 = 129900). Sent to Razorpay unchanged.';

-- Index: payment_order_id_unique (from the UNIQUE constraint)
--   Serves POST /payments (replay check), GET /payments/{orderId}, the refund
--   path (OrderCancelled is keyed by orderId) — every lookup Order Service makes.
-- Index: payment_razorpay_order_unique (from the UNIQUE constraint)
--   Serves webhook processing: Razorpay events identify the payment by
--   razorpay order id, not by our order id. Also the reconciliation update path.
-- Index: payment_razorpay_payment_unique — refund webhooks reference the payment id.

-- Index: payment_unsettled_updated_idx  (PARTIAL)
--   The reconciliation job asks: "rows still CREATED / PENDING / REFUND_PENDING
--   whose updated_at is older than X". A partial index over only the
--   non-terminal statuses stays small however many SUCCESS/FAILED/REFUNDED
--   rows accumulate; ordered by updated_at so the oldest stuck row comes first.
CREATE INDEX payment_unsettled_updated_idx
    ON payment_transaction (status, updated_at)
    WHERE status IN ('CREATED', 'PENDING', 'REFUND_PENDING');

-- Index: payment_user_created_idx
--   Support / debugging: "this user's payments, newest first". Not used by the
--   hot path; cheap to keep.
CREATE INDEX payment_user_created_idx
    ON payment_transaction (user_id, created_at DESC);


-- -----------------------------------------------------------------------------
-- webhook_event — the INBOX: every webhook Razorpay ever delivered to us
-- -----------------------------------------------------------------------------
CREATE TABLE webhook_event (
    id                   BIGSERIAL     PRIMARY KEY,
    provider             VARCHAR(20)   NOT NULL DEFAULT 'razorpay',
    -- Razorpay's X-Razorpay-Event-Id header. Razorpay RETRIES deliveries with
    -- the same id, so this is the deduplication key.
    provider_event_id    VARCHAR(128)  NOT NULL,
    event_type           VARCHAR(100)  NOT NULL,
    razorpay_order_id    VARCHAR(64),
    razorpay_payment_id  VARCHAR(64),
    razorpay_refund_id   VARCHAR(64),
    -- Our order id, when the payload carried it (Razorpay order `receipt`/notes).
    order_id             VARCHAR(64),
    processing_status    VARCHAR(20)   NOT NULL,
    processing_note      VARCHAR(500),
    -- The webhook body with sensitive fields REMOVED before storage (card,
    -- vpa, email, contact, customer/token ids — see razorpay/PayloadRedactor).
    payload              JSONB         NOT NULL,
    request_id           VARCHAR(128),
    received_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
    processed_at         TIMESTAMPTZ,

    CONSTRAINT webhook_status_valid CHECK (processing_status IN ('PROCESSED', 'IGNORED', 'FAILED')),

    -- IDEMPOTENCY OF WEBHOOK PROCESSING, ENFORCED BY THE DATABASE.
    -- The event is inserted in the SAME transaction that applies its effect.
    -- A redelivery hits this constraint, its transaction rolls back (nothing
    -- applied twice, no second Kafka event) and we answer 200 so Razorpay
    -- stops retrying.
    CONSTRAINT webhook_provider_event_unique UNIQUE (provider, provider_event_id)
);

COMMENT ON TABLE webhook_event IS 'Inbox of Razorpay webhooks; UNIQUE(provider, provider_event_id) makes processing idempotent.';

-- Index: webhook_provider_event_unique (from the UNIQUE constraint) — the dedupe check.
-- Index: webhook_order_received_idx
--   Support: "show me every webhook for this Razorpay order, in arrival order".
CREATE INDEX webhook_order_received_idx
    ON webhook_event (razorpay_order_id, received_at);


-- -----------------------------------------------------------------------------
-- payment_refund — one refund per payment (full refunds only)
-- -----------------------------------------------------------------------------
-- Lifecycle: INITIATED (row written, before Razorpay is called) → PROCESSED
-- (Razorpay confirmed) | FAILED (Razorpay refused).
CREATE TABLE payment_refund (
    id                   UUID          PRIMARY KEY,
    payment_id           UUID          NOT NULL REFERENCES payment_transaction (id),
    amount_in_paise      BIGINT        NOT NULL,
    currency             VARCHAR(3)    NOT NULL,
    status               VARCHAR(20)   NOT NULL,
    reason               VARCHAR(100)  NOT NULL,
    razorpay_refund_id   VARCHAR(64),
    last_gateway_error   VARCHAR(500),
    gateway_attempts     INTEGER       NOT NULL DEFAULT 0,
    -- The order-events eventId that triggered it (tracing only).
    triggered_by_event_id VARCHAR(128),
    created_by_request_id VARCHAR(128),
    version              BIGINT        NOT NULL DEFAULT 0,
    created_at           TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ   NOT NULL DEFAULT now(),

    CONSTRAINT refund_amount_positive  CHECK (amount_in_paise > 0),
    CONSTRAINT refund_status_valid     CHECK (status IN ('INITIATED', 'PROCESSED', 'FAILED')),

    -- IDEMPOTENCY OF REFUNDS — THE MOST FINANCIALLY DANGEROUS DUPLICATE —
    -- ENFORCED BY THE DATABASE. The refund row is inserted (and committed)
    -- BEFORE Razorpay is asked for money back. A second OrderCancelled for the
    -- same order — same eventId or a new one, seconds or days later — cannot
    -- insert a second row, so it can never trigger a second Razorpay refund.
    CONSTRAINT refund_payment_unique          UNIQUE (payment_id),
    CONSTRAINT refund_razorpay_refund_unique  UNIQUE (razorpay_refund_id)
);

COMMENT ON TABLE payment_refund IS 'One refund per payment. Inserted BEFORE calling Razorpay; UNIQUE(payment_id) forbids a second refund.';

-- Index: refund_payment_unique (from the UNIQUE constraint) — the dedupe check
--   and the join from a transaction to its refund.
-- Index: refund_initiated_idx (PARTIAL) — reconciliation: refunds we recorded
--   but could not (yet) confirm with Razorpay.
CREATE INDEX refund_initiated_idx
    ON payment_refund (updated_at)
    WHERE status = 'INITIATED';


-- updated_at maintained by the database for every writer.
CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payment_transaction_set_updated_at
    BEFORE UPDATE ON payment_transaction FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER payment_refund_set_updated_at
    BEFORE UPDATE ON payment_refund FOR EACH ROW EXECUTE FUNCTION set_updated_at();
