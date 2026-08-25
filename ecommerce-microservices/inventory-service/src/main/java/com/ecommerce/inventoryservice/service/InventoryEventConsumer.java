package com.ecommerce.inventoryservice.service;

import com.ecommerce.inventoryservice.event.InventoryReservedEvent;
import com.ecommerce.inventoryservice.event.OrderCreatedEvent;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Service;

@Service
@RequiredArgsConstructor
@Slf4j
public class InventoryEventConsumer {

    private final InventoryEventProducer inventoryEventProducer;

    @KafkaListener(topics = "order-created-topic", groupId = "inventory-group")
    public void consumeOrderCreatedEvent(OrderCreatedEvent event) {
        log.info("[kafka] Consumed OrderCreatedEvent: {}", event);

        // Simulate a stock reservation process
        log.info("[inventory] Reserving stock for order {}...", event.getOrderId());

        try {
            // Simulate processing time
            Thread.sleep(500);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }

        // Publish InventoryReservedEvent
        InventoryReservedEvent reservedEvent = InventoryReservedEvent.builder()
                .orderId(event.getOrderId())
                .status("RESERVED")
                .build();
        
        inventoryEventProducer.publishReservedEvent(reservedEvent);
    }
}
