package com.orderflow.payment.razorpay;

/**
 * Two kinds of failure when talking to Razorpay, kept apart because they mean
 * different things to callers and to the circuit breaker:
 * <ul>
 *   <li>{@link Unavailable} — we could not get an answer (timeout, connection
 *       refused, 5xx, breaker open). Retrying later may work. Counts as a
 *       breaker failure. Never marks a payment FAILED on its own.</li>
 *   <li>{@link Rejected} — Razorpay answered 4xx: our request was refused
 *       (bad credentials, invalid amount, already refunded…). Retrying the same
 *       request will not help. Ignored by the breaker (Razorpay is healthy).</li>
 * </ul>
 * Messages carry Razorpay's error {@code code} / {@code description} for logs
 * and the database — never credentials, never request bodies.
 */
public final class RazorpayExceptions {

    private RazorpayExceptions() {
    }

    public static class Unavailable extends RuntimeException {
        public Unavailable(String message, Throwable cause) {
            super(message, cause);
        }

        public Unavailable(String message) {
            super(message);
        }
    }

    public static class Rejected extends RuntimeException {
        private final int httpStatus;
        private final String code;

        public Rejected(int httpStatus, String code, String description) {
            super(description);
            this.httpStatus = httpStatus;
            this.code = code;
        }

        public int getHttpStatus() {
            return httpStatus;
        }

        public String getCode() {
            return code;
        }

        public String summary() {
            return httpStatus + " " + (code != null ? code : "error") + ": " + getMessage();
        }
    }
}
