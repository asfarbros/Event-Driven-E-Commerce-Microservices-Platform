package com.ecommerce.orderservice.dto;

import lombok.*;

import java.math.BigDecimal;

/**
 * Inbound DTO for creating a new order.
 */
@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class CreateOrderRequest {

    private BigDecimal totalAmount;
}
