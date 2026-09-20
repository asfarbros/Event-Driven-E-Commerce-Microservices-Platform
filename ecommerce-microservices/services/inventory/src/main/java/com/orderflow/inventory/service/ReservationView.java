package com.orderflow.inventory.service;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import com.orderflow.inventory.domain.Reservation;
import com.orderflow.inventory.domain.ReservationStatus;

/**
 * Immutable snapshot of a reservation, built INSIDE the transaction so no lazy
 * entity ever leaks out of it (open-in-view is off).
 */
public record ReservationView(
        UUID id,
        String orderId,
        ReservationStatus status,
        Instant expiresAt,
        Instant createdAt,
        Instant resolvedAt,
        List<Line> items) {

    public record Line(String productId, int quantity) {
    }

    public static ReservationView of(Reservation r) {
        List<Line> lines = r.getItems().stream()
                .map(i -> new Line(i.getProductId(), i.getQuantity()))
                .toList();
        return new ReservationView(r.getId(), r.getOrderId(), r.getStatus(), r.getExpiresAt(),
                r.getCreatedAt(), r.getResolvedAt(), lines);
    }

    public int totalQuantity() {
        return items.stream().mapToInt(Line::quantity).sum();
    }
}
