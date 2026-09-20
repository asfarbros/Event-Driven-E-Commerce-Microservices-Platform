package com.orderflow.inventory.web;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import com.orderflow.inventory.config.InventoryProperties;
import com.orderflow.inventory.service.InventoryEvent;
import com.orderflow.inventory.service.InventoryService;
import com.orderflow.inventory.service.InventoryService.Line;
import com.orderflow.inventory.web.ApiDtos.AdjustRequest;
import com.orderflow.inventory.web.ApiDtos.BulkStockRequest;
import com.orderflow.inventory.web.ApiDtos.BulkStockResponse;
import com.orderflow.inventory.web.ApiDtos.FieldError;
import com.orderflow.inventory.web.ApiDtos.ReleaseRequest;
import com.orderflow.inventory.web.ApiDtos.ReleaseResponse;
import com.orderflow.inventory.web.ApiDtos.ReserveRequest;
import com.orderflow.inventory.web.ApiDtos.ReserveResponse;
import com.orderflow.inventory.web.ApiDtos.StockResponse;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Pattern;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * REST surface, called synchronously by Order Service (and, through the
 * gateway at /api/inventory/…, by authenticated clients). The gateway strips
 * the prefix, so paths here have none.
 */
@RestController
@Validated
public class InventoryController {

    private final InventoryService service;
    private final InventoryProperties properties;

    public InventoryController(InventoryService service, InventoryProperties properties) {
        this.service = service;
        this.properties = properties;
    }

    /**
     * Creates a hold. 201 with the new reservation, or 200 with the existing
     * one when the orderId was reserved before (idempotent replay).
     * 409 insufficient_stock lists every short product; nothing is held.
     */
    @PostMapping("/reserve")
    public ResponseEntity<ReserveResponse> reserve(@Valid @RequestBody ReserveRequest body) {
        List<FieldError> problems = new ArrayList<>();
        if (body.items().size() > properties.reserveMaxItems()) {
            problems.add(new FieldError("items", "must contain at most " + properties.reserveMaxItems() + " items"));
        }
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < body.items().size(); i++) {
            var item = body.items().get(i);
            if (!seen.add(item.productId())) {
                problems.add(new FieldError("items[" + i + "].productId", "is listed more than once — merge the quantities into one line"));
            }
            if (item.quantity() > properties.maxQuantityPerItem()) {
                problems.add(new FieldError("items[" + i + "].quantity", "must be at most " + properties.maxQuantityPerItem()));
            }
        }
        if (!problems.isEmpty()) {
            throw new ApiExceptionHandler.BadRequestException(problems);
        }

        List<Line> lines = body.items().stream().map(i -> new Line(i.productId(), i.quantity())).toList();
        InventoryService.ReserveResult result = service.reserve(body.orderId(), lines);
        return ResponseEntity.status(result.created() ? HttpStatus.CREATED : HttpStatus.OK).body(ReserveResponse.of(result));
    }

    /** Compensating action: give a hold back, by orderId or reservationId. Safe to repeat. */
    @PostMapping("/release")
    public ReleaseResponse release(@Valid @RequestBody ReleaseRequest body) {
        boolean byOrder = body.orderId() != null && !body.orderId().isBlank();
        boolean byReservation = body.reservationId() != null;
        if (byOrder == byReservation) {
            throw new ApiExceptionHandler.BadRequestException(List.of(
                    new FieldError("orderId", "exactly one of orderId or reservationId is required")));
        }
        InventoryService.ReleaseResult result = byOrder
                ? service.releaseByOrderId(body.orderId(), InventoryEvent.ReleaseReason.EXPLICIT_RELEASE)
                : service.releaseByReservationId(body.reservationId(), InventoryEvent.ReleaseReason.EXPLICIT_RELEASE);
        return ReleaseResponse.of(result);
    }

    @GetMapping("/stock/{productId}")
    public StockResponse stock(@PathVariable @Pattern(regexp = ApiDtos.ID_PATTERN, message = ApiDtos.ID_MESSAGE) String productId) {
        return StockResponse.of(service.getStock(productId));
    }

    /** Bulk availability: ONE query for all ids. Unknown ids are listed, not errors. */
    @PostMapping("/stock/bulk")
    public BulkStockResponse bulk(@Valid @RequestBody BulkStockRequest body) {
        if (body.productIds().size() > properties.bulkLookupMaxIds()) {
            throw new ApiExceptionHandler.BadRequestException(List.of(
                    new FieldError("productIds", "must contain at most " + properties.bulkLookupMaxIds() + " ids")));
        }
        List<String> distinct = body.productIds().stream().distinct().toList();
        InventoryService.BulkStock result = service.getStockBulk(distinct);
        return new BulkStockResponse(result.stock().stream().map(StockResponse::of).toList(), result.unknown(), Instant.now());
    }

    /**
     * Admin restock: { operation: SET | ADD, quantity }. Creates the row for an
     * unknown product.
     *
     * TODO(auth-roles): restrict to an admin role once the gateway propagates
     * roles (same TODO as Catalog's write endpoints). Today the gateway only
     * guarantees the caller is an authenticated user.
     */
    @PostMapping("/stock/{productId}/adjust")
    public StockResponse adjust(@PathVariable @Pattern(regexp = ApiDtos.ID_PATTERN, message = ApiDtos.ID_MESSAGE) String productId,
                                @Valid @RequestBody AdjustRequest body) {
        int limit = properties.maxQuantityPerItem() * 1000;
        if (Math.abs((long) body.quantity()) > limit) {
            throw new ApiExceptionHandler.BadRequestException(List.of(
                    new FieldError("quantity", "must be between -" + limit + " and " + limit)));
        }
        if (body.operation() == InventoryService.AdjustOperation.SET && body.quantity() < 0) {
            throw new ApiExceptionHandler.BadRequestException(List.of(
                    new FieldError("quantity", "must be zero or more for SET")));
        }
        return StockResponse.of(service.adjust(productId, body.operation(), body.quantity()));
    }
}
