package com.orderflow.payment.domain;

/**
 * Lifecycle of a payment transaction. SUCCESS / FAILED / REFUNDED are settled
 * outcomes; CREATED / PENDING / REFUND_PENDING are the states the
 * reconciliation job watches for rows that stopped moving.
 */
public enum PaymentStatus {
    /** Our row exists; the Razorpay order has not (yet) been created. */
    CREATED,
    /** Razorpay order exists; waiting for the user to complete 2FA. */
    PENDING,
    /** Payment captured. */
    SUCCESS,
    /** Payment failed, abandoned, or the gateway rejected the order. */
    FAILED,
    /** Refund requested with Razorpay, awaiting confirmation. */
    REFUND_PENDING,
    /** Refund processed. */
    REFUNDED
}
