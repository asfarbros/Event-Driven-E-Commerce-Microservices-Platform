package com.orderflow.order.web;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.orderflow.order.config.OrderProperties;
import com.orderflow.order.correlation.Correlation;
import com.orderflow.order.domain.Order;
import com.orderflow.order.domain.OrderStatus;
import com.orderflow.order.service.CheckoutService;
import com.orderflow.order.service.OrderService;
import com.orderflow.order.service.OrderView;
import com.orderflow.order.service.ServiceExceptions.OrderNotFoundException;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * The order API. The gateway strips {@code /api/orders} and injects
 * {@code X-User-Id} after verifying the Clerk session; every handler takes
 * the user from that header ONLY ({@link RequireUser}) and every lookup is
 * scoped to it, so another user's order — read, cancel or list — is a 404
 * indistinguishable from a non-existent id.
 */
@RestController
@Validated
public class OrderController {

    private static final String ID_PATTERN = "^[0-9a-fA-F-]{36}$";

    private final CheckoutService checkout;
    private final OrderService orders;
    private final OrderProperties properties;

    public OrderController(CheckoutService checkout, OrderService orders, OrderProperties properties) {
        this.checkout = checkout;
        this.orders = orders;
        this.properties = properties;
    }

    // ---- bodies --------------------------------------------------------------

    /** Checkout takes no money-relevant input: the cart is server-side and prices come from Catalog. */
    public record CheckoutRequest(@Size(max = 500, message = "is too long") String note) {
    }

    public record CancelRequest(@Size(max = 200, message = "is too long")
                                @Pattern(regexp = "^[A-Za-z0-9 .,_'-]*$", message = "contains unsupported characters") String reason) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record CheckoutResponse(UUID orderId, OrderStatus status, boolean created, long totalInPaise, String currency,
                                   List<OrderView.Line> items, OrderView.Reservation reservation, OrderView.Payment payment,
                                   List<CheckoutService.PriceChange> priceChanges, String requestId, Instant createdAt) {
    }

    public record StatusResponse(UUID orderId, OrderStatus status, Order.PaymentState paymentStatus, Instant updatedAt) {
    }

    public record PageResponse(List<OrderView> items, Map<String, Object> pagination) {
    }

    // ---- POST /  (checkout — the synchronous zone) -----------------------------

    @PostMapping("/")
    public ResponseEntity<CheckoutResponse> checkout(@RequireUser String userId,
                                                     @RequestHeader(value = "Idempotency-Key", required = false)
                                                     @Pattern(regexp = "^[A-Za-z0-9._-]{8,128}$", message = "must be 8-128 characters of letters, digits, '.', '_' or '-'") String idempotencyKey,
                                                     @Valid @RequestBody(required = false) CheckoutRequest body) {
        String fingerprintSource = body != null && body.note() != null ? body.note() : "";
        CheckoutService.CheckoutResult r = checkout.checkout(userId, idempotencyKey, fingerprintSource);
        OrderView o = r.order();
        CheckoutResponse response = new CheckoutResponse(o.orderId(), o.status(), r.created(), o.totalInPaise(), o.currency(),
                o.items(), o.reservation(), o.payment(), r.priceChanges().isEmpty() ? null : r.priceChanges(), Correlation.current(), o.createdAt());
        return ResponseEntity.status(r.created() ? HttpStatus.CREATED : HttpStatus.OK).body(response);
    }

    // ---- GET /  (the user's orders, newest first) ------------------------------

    @GetMapping("/")
    public PageResponse list(@RequireUser String userId,
                             @RequestParam(defaultValue = "1") int page,
                             @RequestParam(required = false) Integer limit) {
        if (page < 1) {
            throw new ApiExceptionHandler.BadRequestException(List.of(new ApiExceptionHandler.FieldError("page", "must be at least 1")));
        }
        int effective = limit == null ? properties.pageLimitDefault() : Math.min(Math.max(limit, 1), properties.pageLimitMax());
        OrderService.PageResult p = orders.list(userId, page, effective);
        return new PageResponse(p.items(), Map.of("page", p.page(), "limit", p.limit(), "total", p.total(), "totalPages", p.totalPages(),
                "hasNext", p.page() < p.totalPages(), "hasPrev", p.page() > 1));
    }

    // ---- GET /{orderId} ---------------------------------------------------------

    @GetMapping("/{orderId}")
    public OrderView get(@RequireUser String userId, @PathVariable String orderId) {
        return orders.get(userId, parse(orderId));
    }

    @GetMapping("/{orderId}/status")
    public StatusResponse status(@RequireUser String userId, @PathVariable String orderId) {
        OrderView o = orders.get(userId, parse(orderId));
        return new StatusResponse(o.orderId(), o.status(), o.paymentStatus(), o.updatedAt());
    }

    // ---- POST /{orderId}/cancel -------------------------------------------------

    @PostMapping("/{orderId}/cancel")
    public Map<String, Object> cancel(@RequireUser String userId, @PathVariable String orderId,
                                      @Valid @RequestBody(required = false) CancelRequest body) {
        OrderService.CancelResult r = orders.cancel(userId, parse(orderId), body != null ? body.reason() : null);
        return Map.of("orderId", r.order().orderId(), "status", r.order().status(), "paymentStatus", r.order().paymentStatus(),
                "cancelled", r.cancelled(), "requestId", Correlation.current());
    }

    private static UUID parse(String orderId) {
        if (orderId == null || !orderId.matches(ID_PATTERN)) {
            throw new OrderNotFoundException(orderId);   // not a valid id → same 404 as "not yours"
        }
        return UUID.fromString(orderId);
    }
}
