package com.orderflow.inventory.domain;

/**
 * Lifecycle of a hold. HELD is the only non-terminal state; every other state
 * is final, which is what makes confirm / release / expire idempotent: once a
 * reservation has left HELD, repeating the transition is a no-op.
 */
public enum ReservationStatus {
    /** Units sit in inventory.reserved; expires_at is in the future. */
    HELD,
    /** Payment succeeded; the units left reserved for good. */
    CONFIRMED,
    /** Cancelled or explicitly released; the units went back to available. */
    RELEASED,
    /** The sweeper released it after expires_at passed. */
    EXPIRED;

    public boolean isTerminal() {
        return this != HELD;
    }
}
