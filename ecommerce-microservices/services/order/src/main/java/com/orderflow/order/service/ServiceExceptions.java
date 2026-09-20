package com.orderflow.order.service;

import java.util.List;

/** Domain-level failures; each maps to one HTTP code in web/ApiExceptionHandler or a retry decision in Kafka. */
public final class ServiceExceptions {

    private ServiceExceptions() {
    }

    public static class OrderNotFoundException extends RuntimeException {
        public OrderNotFoundException(String orderId) {
            super("no order " + orderId + " for this user");
        }
    }

    /** Kafka: event for an order this service does not know (yet). Retried, then parked on the DLT. */
    public static class UnknownOrderException extends RuntimeException {
        public UnknownOrderException(String orderId) {
            super("event references unknown order " + orderId);
        }
    }

    /** Kafka: the order exists but checkout has not reached the state this event needs (e.g. PaymentSucceeded before AWAITING_PAYMENT was committed). Retried. */
    public static class OrderNotReadyException extends RuntimeException {
        public OrderNotReadyException(String orderId, String status) {
            super("order " + orderId + " is " + status + " — not ready for this event yet");
        }
    }

    /** Same Idempotency-Key, different request. */
    public static class IdempotencyConflictException extends RuntimeException {
        public IdempotencyConflictException() {
            super("Idempotency-Key was already used with a different request body");
        }
    }

    public static class CancelNotAllowedException extends RuntimeException {
        public CancelNotAllowedException(String status) {
            super("an order in status " + status + " cannot be cancelled by the user");
        }
    }

    /** Checkout could not proceed for a business reason reported by a dependency (cart empty, product gone, stock short, price changed). */
    public static class CheckoutRejectedException extends RuntimeException {
        private final int status;
        private final String code;
        private final List<?> details;

        public CheckoutRejectedException(int status, String code, String message, List<?> details) {
            super(message);
            this.status = status;
            this.code = code;
            this.details = details;
        }

        public int getStatus() { return status; }
        public String getCode() { return code; }
        public List<?> getDetails() { return details; }
    }

    /** Checkout could not proceed because a dependency was unavailable (the breaker's fallback). Retryable by the client. */
    public static class DependencyUnavailableException extends RuntimeException {
        private final String code;

        public DependencyUnavailableException(String code, String message, Throwable cause) {
            super(message, cause);
            this.code = code;
        }

        public String getCode() {
            return code;
        }
    }
}
