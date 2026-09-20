package com.orderflow.payment.service;

/** Outbound port for payment-events (Kafka in kafka/KafkaPaymentEventPublisher). Called AFTER commit only. */
public interface PaymentEventPublisher {

    void publish(PaymentEvent event);
}
