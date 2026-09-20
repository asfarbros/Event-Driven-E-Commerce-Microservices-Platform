-- =============================================================================
-- V1 — stock (the two-number model) and holds (reservations)
-- =============================================================================
-- Runs once, via Flyway, inside inventory_db as INVENTORY_DB_USER. Hibernate is
-- set to ddl-auto=validate, so this file (and its successors) is the ONLY
-- source of schema. Never edit an applied migration; add V2__*.sql instead.
--
-- Stock is never a single number. Each product row carries:
--   available  units a new buyer can claim right now
--   reserved   units held by someone mid-checkout (OTP window), not yet sold
-- RESERVE  moves available -> reserved (synchronous, creates a HELD reservation)
-- CONFIRM  removes units from reserved permanently (after payment)
-- RELEASE  moves reserved -> available (cancellation, or the expiry sweeper)
-- =============================================================================


-- -----------------------------------------------------------------------------
-- inventory — exactly one row per product
-- -----------------------------------------------------------------------------
CREATE TABLE inventory (
    -- Catalog's product id (a 24-hex MongoDB ObjectId today; any [A-Za-z0-9._-]
    -- token up to 64 chars is accepted so the format can change without a
    -- migration). Natural primary key: it IS the uniqueness rule the spec asks
    -- for, and every lookup / FOR UPDATE lock is by this value.
    product_id  VARCHAR(64)  PRIMARY KEY,
    available   INTEGER      NOT NULL DEFAULT 0,
    reserved    INTEGER      NOT NULL DEFAULT 0,
    -- Optimistic-locking counter (JPA @Version). The reserve path uses
    -- pessimistic row locks, so this is belt-and-braces: any write that slipped
    -- past a lock would still fail on a stale version instead of clobbering.
    version     BIGINT       NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),

    -- LAST LINE OF DEFENCE. Even if application logic had a bug (or someone
    -- ran SQL by hand), the database refuses to let either counter go below
    -- zero. Overselling is a negative `available`; releasing a hold twice is a
    -- negative `reserved`. Both are impossible to persist.
    CONSTRAINT inventory_available_non_negative CHECK (available >= 0),
    CONSTRAINT inventory_reserved_non_negative  CHECK (reserved  >= 0)
);

COMMENT ON TABLE  inventory           IS 'Stock per product: available (claimable now) + reserved (held mid-checkout).';
COMMENT ON COLUMN inventory.available IS 'Units a new buyer can claim right now. Never negative (CHECK).';
COMMENT ON COLUMN inventory.reserved  IS 'Units held by HELD reservations, not yet sold. Never negative (CHECK).';

-- Index: the PRIMARY KEY index on product_id is the only index this table
-- needs. It serves GET /stock/{id}, the IN (...) bulk lookup, the seed upsert
-- and — most importantly — the SELECT ... FOR UPDATE that the reserve /
-- confirm / release paths take on each product row.


-- -----------------------------------------------------------------------------
-- reservation — one HOLD per order (the header)
-- -----------------------------------------------------------------------------
CREATE TABLE reservation (
    id                   UUID         PRIMARY KEY,
    order_id             VARCHAR(64)  NOT NULL,
    -- HELD      units sit in inventory.reserved; expires_at is in the future
    -- CONFIRMED payment succeeded; units left `reserved` permanently
    -- RELEASED  cancelled / explicitly released; units went back to available
    -- EXPIRED   the sweeper released it after expires_at passed
    status               VARCHAR(16)  NOT NULL,
    expires_at           TIMESTAMPTZ  NOT NULL,
    -- X-Request-Id of the request that created the hold (tracing / demos only).
    created_by_request_id VARCHAR(128),
    -- When the hold left HELD (confirm, release or expiry). NULL while HELD.
    resolved_at          TIMESTAMPTZ,
    version              BIGINT       NOT NULL DEFAULT 0,
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT reservation_status_valid
        CHECK (status IN ('HELD', 'CONFIRMED', 'RELEASED', 'EXPIRED')),

    -- IDEMPOTENCY, ENFORCED BY THE DATABASE. Order Service may retry
    -- POST /reserve; two concurrent retries for the same order can both pass
    -- the application-level "does it exist?" check, but only one INSERT can
    -- ever succeed. The loser gets a unique violation, rolls back (so its
    -- stock decrement vanishes) and returns the winner's reservation.
    CONSTRAINT reservation_order_id_unique UNIQUE (order_id)
);

COMMENT ON TABLE reservation IS 'A time-limited hold on stock for one order. Exactly one per order_id.';

-- Index: reservation_order_id_unique (created by the UNIQUE constraint above)
--   Also the lookup path for POST /reserve (idempotent replay), POST /release
--   { orderId } and every Kafka event, all of which are keyed by order id.

-- Index: reservation_held_expires_idx  (PARTIAL)
--   The expiry sweeper asks, every few seconds:
--     WHERE status = 'HELD' AND expires_at <= now()  ORDER BY expires_at  LIMIT n
--   A partial index over ONLY the live holds answers that as a short ordered
--   range scan. Rows leave the index the moment they stop being HELD, so it
--   stays tiny no matter how many confirmed/released reservations accumulate,
--   and a full-table index over historical rows is never scanned.
CREATE INDEX reservation_held_expires_idx
    ON reservation (expires_at)
    WHERE status = 'HELD';


-- -----------------------------------------------------------------------------
-- reservation_item — the products and quantities inside a hold
-- -----------------------------------------------------------------------------
-- Separate from the header so a multi-product order is ONE reservation with
-- ONE status: all its lines are held, confirmed or released together
-- (all-or-nothing), and idempotency is one constraint on the header.
CREATE TABLE reservation_item (
    id              BIGSERIAL    PRIMARY KEY,
    reservation_id  UUID         NOT NULL REFERENCES reservation (id) ON DELETE CASCADE,
    product_id      VARCHAR(64)  NOT NULL REFERENCES inventory (product_id),
    quantity        INTEGER      NOT NULL,

    CONSTRAINT reservation_item_quantity_positive CHECK (quantity > 0),
    -- A product appears at most once per hold (the API rejects duplicate
    -- lines; this makes the rule true even if it did not).
    CONSTRAINT reservation_item_product_unique UNIQUE (reservation_id, product_id)
);

-- Index: reservation_item_product_unique (from the UNIQUE constraint)
--   Leading column reservation_id → loading the lines of one reservation
--   (confirm / release / expiry / API responses) is an index range scan.

-- Index: reservation_item_product_idx
--   Reverse side of the FK to inventory. PostgreSQL does not index FK
--   columns automatically; without this, any check that touches an inventory
--   row's dependants — and the admin question "which holds include product
--   X?" — would scan every reservation line.
CREATE INDEX reservation_item_product_idx
    ON reservation_item (product_id);


-- -----------------------------------------------------------------------------
-- updated_at maintenance — set by the database so it is right for every
-- writer (the service, the seed script, a psql session during a demo).
-- -----------------------------------------------------------------------------
CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER inventory_set_updated_at
    BEFORE UPDATE ON inventory
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER reservation_set_updated_at
    BEFORE UPDATE ON reservation
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
