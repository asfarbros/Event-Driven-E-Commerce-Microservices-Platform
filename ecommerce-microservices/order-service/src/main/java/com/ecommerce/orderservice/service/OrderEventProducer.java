package com.ecommerce.orderservice.service;

import com.ecommerce.orderservice.event.OrderCreatedEvent;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Service;

/**
 * Publishes order-related events to Kafka topics.
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class OrderEventProducer {

    private static final String TOPIC = "order-created-topic";

    private final KafkaTemplate<String, OrderCreatedEvent> kafkaTemplate;

    /**
     * Publish an {@link OrderCreatedEvent} to the order-created-topic.
     *
     * @param event the event payload to publish
     */
    public void publish(OrderCreatedEvent event) {
        log.info("[kafka] Publishing OrderCreatedEvent for order {} to topic '{}'",
                event.getOrderId(), TOPIC);

        kafkaTemplate.send(TOPIC, event.getOrderId().toString(), event)
                .whenComplete((result, ex) -> {
                    if (ex != null) {
                        log.error("[kafka] Failed to publish event for order {}: {}",
                                event.getOrderId(), ex.getMessage());
                    } else {
                        log.info("[kafka] Event published → partition={}, offset={}",
                                result.getRecordMetadata().partition(),
                                result.getRecordMetadata().offset());
                    }
                });
    }
}
