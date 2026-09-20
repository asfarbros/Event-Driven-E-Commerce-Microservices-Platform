package com.orderflow.inventory.domain;

/**
 * Lifecycle of a hold. HELD is the only state that can move freely; CONFIRMED
 * can move exactly once more, to RESTOCKED (a paid order was cancelled);
 * RELEASED, EXPIRED and RESTOCKED are final. That is what makes confirm /
 * release / expire / restock idempotent: repeating a transition that already
 * happened is a no-op.
 */
public enum ReservationStatus {
    /** Units sit in inventory.reserved; expires_at is in the future. */
    HELD,
    /** Payment succeeded; the units left reserved for good. */
    CONFIRMED,
    /** Cancelled or explicitly released; the units went back to available. */
    RELEASED,
    /** The sweeper released it after expires_at passed. */
    EXPIRED,
    /** Was CONFIRMED (sold), then the paid order was cancelled: the units went back to available. Terminal. */
    RESTOCKED;

    /** No longer HELD (units are not in inventory.reserved any more). */
    public boolean isTerminal() {
        return this != HELD;
    }

    /** Nothing can happen to the hold any more. */
    public boolean isFinal() {
        return this == RELEASED || this == EXPIRED || this == RESTOCKED;
    }
}
