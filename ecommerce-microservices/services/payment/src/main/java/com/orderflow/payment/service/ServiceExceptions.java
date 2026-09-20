package com.orderflow.payment.service;

/** Domain-level failures; each maps to one HTTP code in web/ApiExceptionHandler and a retry decision in Kafka. */
public final class ServiceExceptions {

    private ServiceExceptions() {
    }

    public static class PaymentNotFoundException extends RuntimeException {
        public PaymentNotFoundException(String orderId) {
            super("no payment found for orderId " + orderId);
        }
    }

    /** The webhook's signature did not verify — never processed. */
    public static class InvalidWebhookSignatureException extends RuntimeException {
        public InvalidWebhookSignatureException() {
            super("webhook signature verification failed");
        }
    }

    /** The webhook lacked the event id header or was not a Razorpay event body. */
    public static class InvalidWebhookException extends RuntimeException {
        public InvalidWebhookException(String message) {
            super(message);
        }
    }

    /** A refund cannot be made because no money was ever taken (CREATED / PENDING / FAILED). */
    public static class NothingToRefundException extends RuntimeException {
        public NothingToRefundException(String orderId, String status) {
            super("payment for orderId " + orderId + " is " + status + " — there is nothing to refund");
        }
    }
}
