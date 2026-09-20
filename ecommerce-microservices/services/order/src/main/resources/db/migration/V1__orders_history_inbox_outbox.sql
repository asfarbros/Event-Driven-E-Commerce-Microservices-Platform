-- =============================================================================
-- V1 — orders, immutable line snapshots, status history, event inbox, outbox
-- =============================================================================
-- Runs once, via Flyway, inside order_db as ORDER_DB_USER. Hibernate runs with
-- ddl-auto=validate; this file is the only source of schema. Never edit an
-- applied migration; add V2__*.sql.
--
-- MONEY is always an integer number of PAISE (BIGINT) — same rule as Catalog,
-- Cart, Inventory and Payment. The total of an order is computed by THIS
-- service from Catalog's fresh prices at checkout, never taken from a client.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- orders — one row per order; the aggregate root of the checkout saga
-- -----------------------------------------------------------------------------
-- status (fulfilment lifecycle — see service/OrderStateMachine):
--   PENDING           persisted with its line snapshot; nothing reserved yet
--   RESERVED          Inventory holds the stock
--   AWAITING_PAYMENT  Payment created the Razorpay order; the user is with Razorpay (2FA)
--   CONFIRMED         payment succeeded; Inventory converts the hold to a deduction
--   FAILED            checkout failed (no stock / payment failed / dependency down) — terminal
--   CANCELLED         cancelled by the user, by expiry, or by reconciliation — terminal
-- payment_status (money, tracked independently of fulfilment):
--   UNPAID → PAID → REFUND_PENDING → REFUNDED
CREATE TABLE orders (
    id                      UUID          PRIMARY KEY,
    user_id                 VARCHAR(128)  NOT NULL,
    status                  VARCHAR(20)   NOT NULL,
    payment_status          VARCHAR(20)   NOT NULL DEFAULT 'UNPAID',
    total_in_paise          BIGINT        NOT NULL,
    currency                VARCHAR(3)    NOT NULL,
    item_count              INTEGER       NOT NULL,
    total_quantity          INTEGER       NOT NULL,
    -- Ids handed to us by the other services (their aggregates, not ours).
    reservation_id          VARCHAR(64),
    reservation_expires_at  TIMESTAMPTZ,
    payment_id              VARCHAR(64),
    razorpay_order_id       VARCHAR(64),
    razorpay_key_id         VARCHAR(64),
    -- Client-supplied Idempotency-Key (per user) and a fingerprint of the request it covered.
    idempotency_key         VARCHAR(128),
    idempotency_fingerprint VARCHAR(64),
    failure_reason          VARCHAR(500),
    created_by_request_id   VARCHAR(128),
    version                 BIGINT        NOT NULL DEFAULT 0,
    created_at              TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ   NOT NULL DEFAULT now(),

    -- LAST LINE OF DEFENCE: no free or negative orders, only known states.
    CONSTRAINT orders_total_positive       CHECK (total_in_paise > 0),
    CONSTRAINT orders_counts_positive      CHECK (item_count > 0 AND total_quantity > 0),
    CONSTRAINT orders_currency_iso4217     CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT orders_status_valid         CHECK (status IN
        ('PENDING', 'RESERVED', 'AWAITING_PAYMENT', 'CONFIRMED', 'FAILED', 'CANCELLED')),
    CONSTRAINT orders_payment_status_valid CHECK (payment_status IN
        ('UNPAID', 'PAID', 'REFUND_PENDING', 'REFUNDED')),
    -- A CONFIRMED order is a paid order.
    CONSTRAINT orders_confirmed_is_paid    CHECK (status <> 'CONFIRMED' OR payment_status <> 'UNPAID'),

    -- DUPLICATE CHECKOUT, ENFORCED BY THE DATABASE. A user double-clicking
    -- "Pay" sends the same Idempotency-Key twice; only one order can carry
    -- that key for that user. The loser of a concurrent race returns the
    -- winner. (NULL keys — clients that sent none — are not deduplicated.)
    CONSTRAINT orders_user_idempotency_unique UNIQUE (user_id, idempotency_key)
);

COMMENT ON TABLE  orders                IS 'Aggregate root of the checkout saga. Money in integer paise.';
COMMENT ON COLUMN orders.total_in_paise IS 'Sum of line_total_in_paise, computed from Catalog prices at checkout.';

-- Index: orders_user_created_idx
--   GET / (a user''s orders, newest first, paginated): equality on user_id,
--   then the sort column — the index returns rows already in output order.
CREATE INDEX orders_user_created_idx ON orders (user_id, created_at DESC);

-- Index: orders_awaiting_payment_idx  (PARTIAL)
--   The reconciliation job asks for orders stuck in AWAITING_PAYMENT whose
--   updated_at is older than X. Only live candidates are in the index; rows
--   leave it the moment they reach a terminal state.
CREATE INDEX orders_awaiting_payment_idx ON orders (updated_at) WHERE status = 'AWAITING_PAYMENT';

-- Index: orders_user_idempotency_unique (from the UNIQUE constraint) — the
--   replay lookup for POST / with an Idempotency-Key.


-- -----------------------------------------------------------------------------
-- order_item — the IMMUTABLE line snapshot taken at checkout
-- -----------------------------------------------------------------------------
-- What the customer agreed to pay, frozen: product, sku, name and unit price
-- at checkout time. Catalog price changes afterwards never touch these rows
-- (there is no UPDATE path for this table in the service).
CREATE TABLE order_item (
    id                    BIGSERIAL     PRIMARY KEY,
    order_id              UUID          NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
    product_id            VARCHAR(64)   NOT NULL,
    sku                   VARCHAR(64)   NOT NULL,
    name                  VARCHAR(200)  NOT NULL,
    quantity              INTEGER       NOT NULL,
    unit_price_in_paise   BIGINT        NOT NULL,
    line_total_in_paise   BIGINT        NOT NULL,
    currency              VARCHAR(3)    NOT NULL,

    CONSTRAINT order_item_quantity_positive  CHECK (quantity > 0),
    CONSTRAINT order_item_prices_non_negative CHECK (unit_price_in_paise >= 0 AND line_total_in_paise >= 0),
    CONSTRAINT order_item_line_total_correct CHECK (line_total_in_paise = unit_price_in_paise * quantity),
    -- One line per product per order (Cart already merges duplicates).
    CONSTRAINT order_item_product_unique     UNIQUE (order_id, product_id)
);

-- Index: order_item_product_unique (from the UNIQUE constraint) — leading
--   column order_id: loading an order''s lines is an index range scan.


-- -----------------------------------------------------------------------------
-- order_status_history — the audit trail: every transition, in order
-- -----------------------------------------------------------------------------
CREATE TABLE order_status_history (
    id            BIGSERIAL     PRIMARY KEY,
    order_id      UUID          NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
    from_status   VARCHAR(20),
    to_status     VARCHAR(20)   NOT NULL,
    -- What caused it: CHECKOUT | PAYMENT_EVENT | INVENTORY_EVENT | USER | RECONCILIATION
    trigger       VARCHAR(30)   NOT NULL,
    reason        VARCHAR(500),
    -- The Kafka eventId that caused an event-driven transition (tracing).
    event_id      VARCHAR(128),
    request_id    VARCHAR(128),
    created_at    TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Index: history_order_created_idx — "the full lifecycle of order X, in order".
CREATE INDEX history_order_created_idx ON order_status_history (order_id, created_at, id);


-- -----------------------------------------------------------------------------
-- processed_event — the INBOX: every Kafka event this service has applied
-- -----------------------------------------------------------------------------
-- DUPLICATE EVENTS, ENFORCED BY THE DATABASE. The row is inserted in the SAME
-- transaction as the state change it caused. A redelivery hits the primary
-- key, the transaction rolls back, nothing is re-applied, no outbox row is
-- written twice. (The state machine is the second guard: a repeated
-- transition to the same state is a no-op even if the event id were new.)
CREATE TABLE processed_event (
    event_id      VARCHAR(128)  PRIMARY KEY,
    topic         VARCHAR(249)  NOT NULL,
    event_type    VARCHAR(100)  NOT NULL,
    order_id      VARCHAR(64),
    outcome       VARCHAR(30)   NOT NULL,
    processed_at  TIMESTAMPTZ   NOT NULL DEFAULT now()
);
-- The constraint that enforces it is the primary key: processed_event_pkey.


-- -----------------------------------------------------------------------------
-- outbox_event — the TRANSACTIONAL OUTBOX (dual-write solution)
-- -----------------------------------------------------------------------------
-- A state change and the message it must cause are written in ONE database
-- transaction: the orders row, its history row, and an outbox row. A relay
-- then publishes unpublished rows (Kafka order-events, or the RabbitMQ
-- notification command) and marks them published. If the service dies
-- between commit and publish, the row is still there on restart and gets
-- published — the message is never lost. It may be published TWICE (crash
-- after the broker acked, before published_at was written): consumers
-- deduplicate on the message id (event_id / message_id), which is stable.
CREATE TABLE outbox_event (
    id              UUID          PRIMARY KEY,
    order_id        VARCHAR(64)   NOT NULL,
    destination     VARCHAR(10)   NOT NULL,           -- KAFKA | RABBITMQ
    target          VARCHAR(249)  NOT NULL,           -- topic (Kafka) or exchange (RabbitMQ)
    routing_key     VARCHAR(249)  NOT NULL,           -- record key (Kafka) or routing key (RabbitMQ)
    event_type      VARCHAR(100)  NOT NULL,
    -- Stable message id: eventId for Kafka, messageId for RabbitMQ. Consumers dedupe on it.
    message_id      VARCHAR(128)  NOT NULL,
    payload         JSONB         NOT NULL,
    correlation_id  VARCHAR(128),
    attempts        INTEGER       NOT NULL DEFAULT 0,
    last_error      VARCHAR(500),
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
    published_at    TIMESTAMPTZ,

    CONSTRAINT outbox_destination_valid CHECK (destination IN ('KAFKA', 'RABBITMQ')),
    -- DUPLICATE NOTIFICATIONS: the RabbitMQ message id is deterministic per
    -- (order, command) — e.g. "notify-<orderId>-order.confirmed" — so even two
    -- code paths that both decide to notify can only ever enqueue ONE command.
    CONSTRAINT outbox_message_id_unique  UNIQUE (message_id)
);

-- Index: outbox_unpublished_idx  (PARTIAL)
--   The relay's query: unpublished rows, oldest first. Published rows leave
--   the index, so the relay never scans history.
CREATE INDEX outbox_unpublished_idx ON outbox_event (created_at) WHERE published_at IS NULL;

-- Index: outbox_order_idx — "every message this order produced" (support / demos).
CREATE INDEX outbox_order_idx ON outbox_event (order_id, created_at);


-- updated_at maintained by the database for every writer.
CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER orders_set_updated_at
    BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();
