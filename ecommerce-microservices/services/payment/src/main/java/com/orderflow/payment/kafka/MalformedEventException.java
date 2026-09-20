package com.orderflow.payment.kafka;

/**
 * A record on order-events that cannot be understood (not JSON, missing
 * eventType / orderId). Marked NOT retryable in {@link KafkaConsumerConfig}:
 * it goes straight to the dead-letter topic.
 */
public class MalformedEventException extends RuntimeException {

    public MalformedEventException(String message) {
        super(message);
    }
}
