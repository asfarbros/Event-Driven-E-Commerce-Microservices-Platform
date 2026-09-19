package com.ecommerce.orderservice.service;

import com.ecommerce.orderservice.dto.CreateOrderRequest;
import com.ecommerce.orderservice.dto.OrderResponse;
import com.ecommerce.orderservice.event.OrderCreatedEvent;
import com.ecommerce.orderservice.model.Order;
import com.ecommerce.orderservice.model.OrderStatus;
import com.ecommerce.orderservice.repository.OrderRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Core business logic for order management.
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class OrderService {

    private final OrderRepository orderRepository;
    private final OrderEventProducer orderEventProducer;

    /**
     * Create a new order, persist it with PENDING status,
     * then publish an OrderCreatedEvent to Kafka.
     *
     * @param userId  the user placing the order (from X-User-Id header)
     * @param request the order details
     * @return the created order response
     */
    @Transactional
    public OrderResponse createOrder(String userId, CreateOrderRequest request) {
        log.info("[order] Creating order for user '{}'", userId);

        // 1. Build and persist the order
        Order order = Order.builder()
                .userId(userId)
                .totalAmount(request.getTotalAmount())
                .status(OrderStatus.PENDING)
                .build();

        order = orderRepository.save(order);
        log.info("[order] Order {} saved with status PENDING", order.getId());

        // 2. Publish Kafka event
        OrderCreatedEvent event = OrderCreatedEvent.builder()
                .orderId(order.getId())
                .userId(order.getUserId())
                .totalAmount(order.getTotalAmount())
                .status(order.getStatus().name())
                .createdAt(order.getCreatedAt())
                .build();

        orderEventProducer.publish(event);

        // 3. Return response
        return OrderResponse.builder()
                .id(order.getId())
                .userId(order.getUserId())
                .totalAmount(order.getTotalAmount())
                .status(order.getStatus().name())
                .createdAt(order.getCreatedAt())
                .build();
    }
}
