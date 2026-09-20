package com.orderflow.inventory.web;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.orderflow.inventory.domain.ReservationStatus;
import com.orderflow.inventory.service.InventoryService;
import com.orderflow.inventory.service.ReservationView;
import com.orderflow.inventory.service.StockView;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

/**
 * Request / response bodies. Requests carry Bean Validation constraints
 * (→ 400 validation_error with field-level details); env-driven limits
 * (max items, max quantity, max bulk ids) are checked in the controller.
 */
public final class ApiDtos {

    private ApiDtos() {
    }

    public static final String ID_PATTERN = "^[A-Za-z0-9._-]{1,64}$";
    static final String ID_MESSAGE = "must be 1-64 characters of letters, digits, '.', '_' or '-'";

    // ---- POST /reserve ------------------------------------------------------

    public record ReserveItemRequest(
            @NotBlank(message = "is required") @Pattern(regexp = ID_PATTERN, message = ID_MESSAGE) String productId,
            @NotNull(message = "is required") @Min(value = 1, message = "must be at least 1")
            @Max(value = 1_000_000, message = "is too large") Integer quantity) {
    }

    public record ReserveRequest(
            @NotBlank(message = "is required") @Pattern(regexp = ID_PATTERN, message = ID_MESSAGE) String orderId,
            @NotEmpty(message = "must contain at least one item") @Size(max = 500, message = "has too many items")
            List<@Valid @NotNull(message = "must not be null") ReserveItemRequest> items) {
    }

    public record ReservedItem(String productId, int quantity, String outcome) {
    }

    /**
     * {@code created} is true when this call made the hold, false when the
     * orderId had already been reserved and the existing hold is returned.
     */
    public record ReserveResponse(UUID reservationId, String orderId, ReservationStatus status, boolean created,
                                  Instant expiresAt, Instant createdAt, List<ReservedItem> items, int totalQuantity) {

        static ReserveResponse of(InventoryService.ReserveResult result) {
            ReservationView r = result.reservation();
            List<ReservedItem> items = r.items().stream()
                    .map(i -> new ReservedItem(i.productId(), i.quantity(), r.status().name()))
                    .toList();
            return new ReserveResponse(r.id(), r.orderId(), r.status(), result.created(), r.expiresAt(), r.createdAt(),
                    items, r.totalQuantity());
        }
    }

    // ---- POST /release ------------------------------------------------------

    /** Exactly one of orderId / reservationId must be given. */
    public record ReleaseRequest(
            @Pattern(regexp = ID_PATTERN, message = ID_MESSAGE) String orderId,
            UUID reservationId) {
    }

    public record ReleaseResponse(UUID reservationId, String orderId, ReservationStatus status, boolean released,
                                  Instant resolvedAt, List<ReservationView.Line> items, int totalQuantity) {

        static ReleaseResponse of(InventoryService.ReleaseResult result) {
            ReservationView r = result.reservation();
            return new ReleaseResponse(r.id(), r.orderId(), r.status(), result.released(), r.resolvedAt(), r.items(),
                    r.totalQuantity());
        }
    }

    // ---- GET /stock/{productId}, POST /stock/bulk ---------------------------

    public record StockResponse(String productId, int available, int reserved, Instant updatedAt) {

        static StockResponse of(StockView v) {
            return new StockResponse(v.productId(), v.available(), v.reserved(), v.updatedAt());
        }
    }

    public record BulkStockRequest(
            @NotEmpty(message = "must contain at least one productId") @Size(max = 1000, message = "has too many ids")
            List<@NotBlank(message = "must not be blank") @Pattern(regexp = ID_PATTERN, message = ID_MESSAGE) String> productIds) {
    }

    public record BulkStockResponse(List<StockResponse> stock, List<String> unknown, Instant asOf) {
    }

    // ---- POST /stock/{productId}/adjust -------------------------------------

    public record AdjustRequest(
            @NotNull(message = "is required") InventoryService.AdjustOperation operation,
            @NotNull(message = "is required") Integer quantity) {
    }

    // ---- Errors -------------------------------------------------------------

    /** The error shape shared by every OrderFlow service: { error, message, requestId[, details] }. */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record ApiError(String error, String message, String requestId, List<? extends Object> details) {
    }

    public record FieldError(String field, String message) {
    }

    /** Health snapshot (same keys as the Node services' /health). */
    public record HealthResponse(String status, String service, String version, long uptimeSeconds, Instant timestamp,
                                 Map<String, Object> db, Map<String, Object> kafka, Map<String, Object> sweeper,
                                 String requestId) {
    }
}
