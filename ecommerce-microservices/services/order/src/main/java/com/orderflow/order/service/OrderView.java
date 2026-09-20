package com.orderflow.order.service;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import com.orderflow.order.domain.Order;
import com.orderflow.order.domain.OrderItem;
import com.orderflow.order.domain.OrderStatus;
import com.orderflow.order.domain.OrderStatusHistory;

/** Immutable snapshot of an order built inside the transaction (open-in-view is off). */
public record OrderView(
        UUID orderId,
        String userId,
        OrderStatus status,
        Order.PaymentState paymentStatus,
        long totalInPaise,
        String currency,
        int itemCount,
        int totalQuantity,
        List<Line> items,
        Reservation reservation,
        Payment payment,
        String failureReason,
        List<HistoryEntry> history,
        Instant createdAt,
        Instant updatedAt) {

    public record Line(String productId, String sku, String name, int quantity, long unitPriceInPaise, long lineTotalInPaise, String currency) {
        static Line of(OrderItem i) {
            return new Line(i.getProductId(), i.getSku(), i.getName(), i.getQuantity(), i.getUnitPriceInPaise(), i.getLineTotalInPaise(), i.getCurrency());
        }
    }

    public record Reservation(String reservationId, Instant expiresAt) {
    }

    /** What the browser needs to open the Razorpay widget (amount = OUR total). */
    public record Payment(String paymentId, String razorpayOrderId, String razorpayKeyId, long amountInPaise, String currency) {
    }

    public record HistoryEntry(OrderStatus from, OrderStatus to, Order.Trigger trigger, String reason, String eventId, String requestId, Instant at) {
        static HistoryEntry of(OrderStatusHistory h) {
            return new HistoryEntry(h.getFromStatus(), h.getToStatus(), h.getTrigger(), h.getReason(), h.getEventId(), h.getRequestId(), h.getCreatedAt());
        }
    }

    public static OrderView of(Order o, boolean withHistory) {
        return new OrderView(o.getId(), o.getUserId(), o.getStatus(), o.getPaymentStatus(), o.getTotalInPaise(), o.getCurrency(),
                o.getItemCount(), o.getTotalQuantity(),
                o.getItems().stream().map(Line::of).toList(),
                o.getReservationId() != null ? new Reservation(o.getReservationId(), o.getReservationExpiresAt()) : null,
                o.getRazorpayOrderId() != null ? new Payment(o.getPaymentId(), o.getRazorpayOrderId(), o.getRazorpayKeyId(), o.getTotalInPaise(), o.getCurrency()) : null,
                o.getFailureReason(),
                withHistory ? o.getHistory().stream().map(HistoryEntry::of).toList() : null,
                o.getCreatedAt(), o.getUpdatedAt());
    }
}
