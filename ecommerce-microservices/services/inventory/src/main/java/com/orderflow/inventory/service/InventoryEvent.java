package com.orderflow.inventory.service;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * EVENT CONTRACT for the {@code inventory-events} topic. Order Service (Step 6)
 * consumes these — the shape below, and the record headers listed in the
 * README, are the contract. Fields never change meaning; additions bump
 * {@code version}.
 *
 * <pre>
 * {
 *   "eventId":       "b7f2...-...",              // UUID, unique per event (consumer dedupe key)
 *   "eventType":     "InventoryReserved",        // see EventType
 *   "version":       1,                          // schema version of this envelope
 *   "source":        "inventory",                // producing service
 *   "occurredAt":    "2026-09-20T10:15:30.123Z", // ISO-8601 UTC
 *   "correlationId": "…",                        // the X-Request-Id of the originating request (also a header)
 *   "orderId":       "ord_123",                  // Kafka record KEY — all events of one order share a partition
 *   "reservationId": "5d6e…",                    // UUID of the hold
 *   "reason":        "ORDER_CANCELLED",          // InventoryReleased / InventoryConfirmFailed only, else absent
 *   "expiresAt":     "2026-09-20T10:25:30.123Z", // InventoryReserved only, else absent
 *   "items":         [ { "productId": "…", "quantity": 2 } ]
 * }
 * </pre>
 *
 * Event types:
 * <ul>
 *   <li>{@code InventoryReserved}     — a hold was created (POST /reserve succeeded).</li>
 *   <li>{@code InventoryConfirmed}    — the hold became a permanent deduction (OrderConfirmed consumed).</li>
 *   <li>{@code InventoryReleased}     — the hold went back to available. {@code reason} =
 *       {@code ORDER_CANCELLED} (OrderCancelled consumed) | {@code EXPLICIT_RELEASE} (POST /release) |
 *       {@code EXPIRED} (sweeper).</li>
 *   <li>{@code InventoryConfirmFailed} — OrderConfirmed arrived for a hold that is no longer HELD
 *       (it had expired or been released); the stock was NOT deducted. {@code reason} = the hold's status.</li>
 * </ul>
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record InventoryEvent(
        String eventId,
        String eventType,
        int version,
        String source,
        Instant occurredAt,
        String correlationId,
        String orderId,
        UUID reservationId,
        String reason,
        Instant expiresAt,
        List<ReservationView.Line> items) {

    public static final int SCHEMA_VERSION = 1;
    public static final String SOURCE = "inventory";

    public static final class EventType {
        public static final String RESERVED = "InventoryReserved";
        public static final String CONFIRMED = "InventoryConfirmed";
        public static final String RELEASED = "InventoryReleased";
        public static final String CONFIRM_FAILED = "InventoryConfirmFailed";

        private EventType() {
        }
    }

    public static final class ReleaseReason {
        public static final String ORDER_CANCELLED = "ORDER_CANCELLED";
        public static final String EXPLICIT_RELEASE = "EXPLICIT_RELEASE";
        public static final String EXPIRED = "EXPIRED";

        private ReleaseReason() {
        }
    }

    public static InventoryEvent reserved(ReservationView r, String correlationId) {
        return of(EventType.RESERVED, r, correlationId, null, r.expiresAt());
    }

    public static InventoryEvent confirmed(ReservationView r, String correlationId) {
        return of(EventType.CONFIRMED, r, correlationId, null, null);
    }

    public static InventoryEvent released(ReservationView r, String reason, String correlationId) {
        return of(EventType.RELEASED, r, correlationId, reason, null);
    }

    public static InventoryEvent confirmFailed(ReservationView r, String correlationId) {
        return of(EventType.CONFIRM_FAILED, r, correlationId, r.status().name(), null);
    }

    private static InventoryEvent of(String type, ReservationView r, String correlationId, String reason, Instant expiresAt) {
        return new InventoryEvent(UUID.randomUUID().toString(), type, SCHEMA_VERSION, SOURCE, Instant.now(),
                correlationId, r.orderId(), r.id(), reason, expiresAt, r.items());
    }
}
