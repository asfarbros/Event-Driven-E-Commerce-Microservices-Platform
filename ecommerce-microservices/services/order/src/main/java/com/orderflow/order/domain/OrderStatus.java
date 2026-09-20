package com.orderflow.order.domain;

import java.util.EnumSet;
import java.util.Map;
import java.util.Set;

/**
 * THE ORDER STATE MACHINE. Every status change in the service goes through
 * {@link Order#transitionTo}, which consults {@link #ALLOWED} — nothing
 * assigns a status directly.
 *
 * <pre>
 *                      ┌──────────────────────── (stock short / dependency down) ────────┐
 *                      │                                                                  ▼
 *   PENDING ──► RESERVED ──► AWAITING_PAYMENT ──► CONFIRMED                             FAILED
 *      │             │              │  │  │           │
 *      └── FAILED    └── FAILED     │  │  └── FAILED  (PaymentFailed)                   (terminal)
 *                                   │  └────── CANCELLED (user cancel / hold expired / abandoned)
 *                                   └───────── CONFIRMED (PaymentSucceeded)
 *                                                     │
 *                                                     └── CANCELLED (user cancel → refund; stock gone after payment → refund)
 * </pre>
 *
 * Rules enforced by the code, not by convention:
 * <ul>
 *   <li>Only the arrows above are legal. Anything else throws
 *       {@link IllegalTransitionException} and the caller decides (usually:
 *       log as stale and ignore, never overwrite).</li>
 *   <li>A transition to the CURRENT status is a no-op (idempotent), never an error.</li>
 *   <li>FAILED and CANCELLED are terminal: nothing leaves them, so a late or
 *       out-of-order event can never resurrect an order. CONFIRMED is terminal
 *       for fulfilment except for a cancellation-with-refund.</li>
 * </ul>
 */
public enum OrderStatus {
    /** Persisted with its line snapshot and total; nothing reserved yet. */
    PENDING,
    /** Inventory holds the stock (reservation id recorded). */
    RESERVED,
    /** Payment created the Razorpay order; the user is completing 2FA with Razorpay. */
    AWAITING_PAYMENT,
    /** Payment succeeded; Inventory converts the hold into a permanent deduction. */
    CONFIRMED,
    /** Checkout failed: no stock, dependency down, or the payment failed. Terminal. */
    FAILED,
    /** Cancelled by the user, by hold expiry, or by reconciliation. Terminal. */
    CANCELLED;

    static final Map<OrderStatus, Set<OrderStatus>> ALLOWED = Map.of(
            PENDING, EnumSet.of(RESERVED, FAILED),
            RESERVED, EnumSet.of(AWAITING_PAYMENT, FAILED),
            AWAITING_PAYMENT, EnumSet.of(CONFIRMED, FAILED, CANCELLED),
            CONFIRMED, EnumSet.of(CANCELLED),
            FAILED, EnumSet.noneOf(OrderStatus.class),
            CANCELLED, EnumSet.noneOf(OrderStatus.class));

    public boolean canTransitionTo(OrderStatus target) {
        return ALLOWED.get(this).contains(target);
    }

    public boolean isTerminal() {
        return this == FAILED || this == CANCELLED;
    }

    /** States from which a user may cancel. */
    public boolean isUserCancellable() {
        return this == AWAITING_PAYMENT || this == CONFIRMED;
    }

    public static class IllegalTransitionException extends RuntimeException {
        private final OrderStatus from;
        private final OrderStatus to;

        public IllegalTransitionException(OrderStatus from, OrderStatus to) {
            super("illegal order transition " + from + " -> " + to);
            this.from = from;
            this.to = to;
        }

        public OrderStatus getFrom() {
            return from;
        }

        public OrderStatus getTo() {
            return to;
        }
    }
}
