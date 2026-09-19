package com.ecommerce.inventoryservice.service;

import com.ecommerce.inventoryservice.event.InventoryReservedEvent;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Service;

@Service
@RequiredArgsConstructor
@Slf4j
public class InventoryEventProducer {

    private static final String TOPIC = "inventory-reserved-topic";
    private final KafkaTemplate<String, InventoryReservedEvent> kafkaTemplate;

    public void publishReservedEvent(InventoryReservedEvent event) {
        log.info("[kafka] Publishing InventoryReservedEvent for order {} to topic '{}'", event.getOrderId(), TOPIC);
        kafkaTemplate.send(TOPIC, event.getOrderId().toString(), event)
                .whenComplete((result, ex) -> {
                    if (ex != null) {
                        log.error("[kafka] Failed to publish InventoryReservedEvent for order {}", event.getOrderId(), ex);
                    } else {
                        log.info("[kafka] InventoryReservedEvent published successfully for order {}", event.getOrderId());
                    }
                });
    }
}
