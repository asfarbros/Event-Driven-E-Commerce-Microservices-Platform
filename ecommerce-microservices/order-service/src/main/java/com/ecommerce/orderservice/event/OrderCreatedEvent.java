package com.ecommerce.orderservice.event;

import lombok.*;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

/**
 * Event payload published to Kafka when a new order is created.
 *
 * Topic: order-created-topic
 */
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class OrderCreatedEvent {

    private UUID orderId;
    private String userId;
    private BigDecimal totalAmount;
    private String status;
    private Instant createdAt;
}
