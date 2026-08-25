package com.ecommerce.orderservice.dto;

import lombok.*;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

/**
 * Outbound DTO representing the response after an order is created.
 */
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class OrderResponse {

    private UUID id;
    private String userId;
    private BigDecimal totalAmount;
    private String status;
    private Instant createdAt;
}
