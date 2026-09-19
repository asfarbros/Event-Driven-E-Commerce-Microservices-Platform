package com.ecommerce.orderservice.controller;

import com.ecommerce.orderservice.dto.CreateOrderRequest;
import com.ecommerce.orderservice.dto.OrderResponse;
import com.ecommerce.orderservice.service.OrderService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

/**
 * REST controller for order operations.
 *
 * Proxied by the API Gateway at /api/orders → http://order-service:8080
 */
@RestController
@RequestMapping("/")
@RequiredArgsConstructor
@Slf4j
public class OrderController {

    private final OrderService orderService;

    /**
     * POST / — Create a new order.
     *
     * Expects the {@code X-User-Id} header (injected by the API Gateway's
     * Clerk authentication middleware).
     *
     * @param userId  extracted from X-User-Id header
     * @param request body containing totalAmount
     * @return the newly created order
     */
    @PostMapping
    public ResponseEntity<?> createOrder(
            @RequestHeader(value = "X-User-Id", required = false) String userId,
            @RequestBody CreateOrderRequest request) {

        if (userId == null || userId.isBlank()) {
            log.warn("[order] Rejected request – missing X-User-Id header");
            return ResponseEntity
                    .status(HttpStatus.BAD_REQUEST)
                    .body(Map.of(
                            "error", "Bad Request",
                            "message", "Missing X-User-Id header"
                    ));
        }

        if (request.getTotalAmount() == null) {
            return ResponseEntity
                    .status(HttpStatus.BAD_REQUEST)
                    .body(Map.of(
                            "error", "Bad Request",
                            "message", "totalAmount is required"
                    ));
        }

        OrderResponse response = orderService.createOrder(userId, request);

        log.info("[order] Order {} created successfully for user '{}'",
                response.getId(), userId);

        return ResponseEntity.status(HttpStatus.CREATED).body(response);
    }

    /**
     * GET /health — Health check.
     */
    @GetMapping("/health")
    public ResponseEntity<Map<String, String>> health() {
        return ResponseEntity.ok(Map.of(
                "status", "ok",
                "service", "order-service"
        ));
    }
}
