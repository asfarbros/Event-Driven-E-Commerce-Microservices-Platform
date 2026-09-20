-- =============================================================================
-- V2 — RESTOCKED: a CONFIRMED hold whose units were returned to stock
-- =============================================================================
-- Bug fix (Step 6 verification #17): cancelling a PAID order refunded the
-- customer but left the sold units gone for good, because a CONFIRMED
-- reservation had no way back. This adds the terminal status RESTOCKED:
--
--   HELD ──► CONFIRMED ──► RESTOCKED      (reserved → gone at confirm; available += quantity at restock)
--
-- Only CONFIRMED can become RESTOCKED, and RESTOCKED is terminal, so a hold
-- can be restocked at most once — the transition is applied as a conditional
-- UPDATE ... WHERE status = 'CONFIRMED' (see InventoryService.restock), which
-- the database evaluates atomically under the row lock.
--
-- The partial index reservation_held_expires_idx (WHERE status = 'HELD') is
-- unaffected. V1 is never edited; a CHECK constraint is replaced by dropping
-- and re-adding it.
-- =============================================================================

ALTER TABLE reservation DROP CONSTRAINT reservation_status_valid;

ALTER TABLE reservation ADD CONSTRAINT reservation_status_valid
    CHECK (status IN ('HELD', 'CONFIRMED', 'RELEASED', 'EXPIRED', 'RESTOCKED'));

COMMENT ON COLUMN reservation.status IS
    'HELD (units in inventory.reserved) | CONFIRMED (sold) | RELEASED / EXPIRED (back to available before payment) | RESTOCKED (sold, then returned to available after a paid cancellation)';
