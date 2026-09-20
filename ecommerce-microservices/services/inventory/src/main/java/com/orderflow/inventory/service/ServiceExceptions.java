package com.orderflow.inventory.service;

import java.util.List;

/**
 * Domain-level failures. Each maps to one HTTP status / error code in
 * {@code web/ApiExceptionHandler} and to a retry decision in the Kafka
 * consumer. None of them carries SQL or driver details.
 */
public final class ServiceExceptions {

    private ServiceExceptions() {
    }

    /** One product that could not be reserved, with exactly how short it is. */
    public record Shortage(String productId, int requested, int available, int shortBy, String reason) {
        public static final String INSUFFICIENT = "insufficient";
        public static final String UNKNOWN_PRODUCT = "unknown_product";
    }

    /** Reserve failed for at least one line; NOTHING was held (all-or-nothing). */
    public static class InsufficientStockException extends RuntimeException {
        private final String orderId;
        private final List<Shortage> shortages;

        public InsufficientStockException(String orderId, List<Shortage> shortages) {
            super("insufficient stock for " + shortages.size() + " product(s)");
            this.orderId = orderId;
            this.shortages = List.copyOf(shortages);
        }

        public String getOrderId() {
            return orderId;
        }

        public List<Shortage> getShortages() {
            return shortages;
        }
    }

    public static class ReservationNotFoundException extends RuntimeException {
        public ReservationNotFoundException(String what) {
            super("no reservation found for " + what);
        }
    }

    /** POST /restock on a hold that is not CONFIRMED (HELD / RELEASED / EXPIRED). A RESTOCKED replay is not an error. */
    public static class ReservationNotRestockableException extends RuntimeException {
        private final String status;

        public ReservationNotRestockableException(String orderId, String status) {
            super("reservation for orderId " + orderId + " is " + status + " - only a CONFIRMED hold can be restocked");
            this.status = status;
        }

        public String getStatus() {
            return status;
        }
    }

    public static class ProductNotFoundException extends RuntimeException {
        private final String productId;

        public ProductNotFoundException(String productId) {
            super("no stock row for product " + productId);
            this.productId = productId;
        }

        public String getProductId() {
            return productId;
        }
    }

    /** An admin adjustment that would take available below zero. */
    public static class InvalidAdjustmentException extends RuntimeException {
        public InvalidAdjustmentException(String message) {
            super(message);
        }
    }
}
