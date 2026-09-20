package com.orderflow.order.clients;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.orderflow.order.config.OrderProperties;
import com.orderflow.order.correlation.Correlation;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;

/**
 * The four typed clients, each a thin mapping of the other service's
 * documented contract onto records. Contracts are quoted from the owning
 * service's README; nothing here invents fields.
 */
public final class Clients {

    private Clients() {
    }

    // -------------------------------------------------------------------------
    // CART — GET /snapshot (strict), DELETE /  (services/cart/README.md)
    // -------------------------------------------------------------------------
    @Component
    public static class Cart extends ServiceClient {

        public record Line(String productId, String sku, String name, int quantity, long unitPriceInPaise, long lineTotalInPaise, String currency) {
        }

        public record Snapshot(String userId, List<Line> items, int itemCount, int totalQuantity, String currency,
                               long totalInPaise, String pricedAt, String snapshotAt) {
        }

        public Cart(OrderProperties p, ObjectMapper om) {
            super("cart", p.clients().cartUrl(), p.clients().cartTimeoutMs(), p.breaker(), om);
        }

        /** Strict priced cart: 409 cart_empty / cart_has_unavailable_items, 503 pricing_unavailable — never degraded. */
        public Snapshot snapshot(String userId) {
            JsonNode j = call("snapshot", () -> client.get().uri("/snapshot")
                    .header("X-User-Id", userId).header(Correlation.HEADER, requestId())
                    .retrieve().body(JsonNode.class));
            List<Line> lines = new ArrayList<>();
            for (JsonNode i : j.path("items")) {
                lines.add(new Line(i.path("productId").asText(), i.path("sku").asText(), i.path("name").asText(),
                        i.path("quantity").asInt(), i.path("unitPriceInPaise").asLong(), i.path("lineTotalInPaise").asLong(),
                        i.path("currency").asText()));
            }
            return new Snapshot(j.path("userId").asText(), lines, j.path("itemCount").asInt(), j.path("totalQuantity").asInt(),
                    j.path("currency").asText(), j.path("totalInPaise").asLong(), j.path("pricedAt").asText(null), j.path("snapshotAt").asText(null));
        }

        /** Best-effort after the order is placed (the cart is no longer the source of anything). */
        public void clear(String userId) {
            call("clear", () -> {
                client.delete().uri("/").header("X-User-Id", userId).header(Correlation.HEADER, requestId()).retrieve().toBodilessEntity();
                return objectMapper.createObjectNode();
            });
        }
    }

    // -------------------------------------------------------------------------
    // CATALOG — POST /products/prices  (services/catalog/README.md)
    // -------------------------------------------------------------------------
    @Component
    public static class Catalog extends ServiceClient {

        public record Price(String productId, String sku, String name, long priceInPaise, String currency) {
        }

        public record Unavailable(String productId, String reason) {
        }

        public record Prices(List<Price> prices, List<Unavailable> unavailable, String asOf) {
        }

        public Catalog(OrderProperties p, ObjectMapper om) {
            super("catalog", p.clients().catalogUrl(), p.clients().catalogTimeoutMs(), p.breaker(), om);
        }

        /** Fresh prices for every product in one call. Money = integer paise. */
        public Prices prices(List<String> productIds) {
            JsonNode j = call("prices", () -> client.post().uri("/products/prices").contentType(MediaType.APPLICATION_JSON)
                    .header(Correlation.HEADER, requestId())
                    .body(Map.of("productIds", productIds)).retrieve().body(JsonNode.class));
            List<Price> prices = new ArrayList<>();
            for (JsonNode n : j.path("prices")) {
                prices.add(new Price(n.path("productId").asText(), n.path("sku").asText(), n.path("name").asText(),
                        n.path("priceInPaise").asLong(), n.path("currency").asText()));
            }
            List<Unavailable> unavailable = new ArrayList<>();
            for (JsonNode n : j.path("unavailable")) {
                unavailable.add(new Unavailable(n.path("productId").asText(), n.path("reason").asText()));
            }
            return new Prices(prices, unavailable, j.path("asOf").asText(null));
        }
    }

    // -------------------------------------------------------------------------
    // INVENTORY — POST /reserve, POST /release  (services/inventory/README.md)
    // -------------------------------------------------------------------------
    @Component
    public static class Inventory extends ServiceClient {

        public record ReserveLine(String productId, int quantity) {
        }

        public record Reservation(String reservationId, String orderId, String status, boolean created, String expiresAt) {
        }

        public record Shortage(String productId, int requested, int available, int shortBy, String reason) {
        }

        /** 409 insufficient_stock, with the per-product shortages Inventory reported. */
        public static class InsufficientStock extends RuntimeException {
            private final List<Shortage> shortages;

            InsufficientStock(String message, List<Shortage> shortages) {
                super(message);
                this.shortages = shortages;
            }

            public List<Shortage> getShortages() {
                return shortages;
            }
        }

        public Inventory(OrderProperties p, ObjectMapper om) {
            super("inventory", p.clients().inventoryUrl(), p.clients().inventoryTimeoutMs(), p.breaker(), om);
        }

        /** Creates (or replays, idempotent on orderId) the hold. Throws InsufficientStock on 409 insufficient_stock. */
        public Reservation reserve(String orderId, List<ReserveLine> lines) {
            try {
                JsonNode j = call("reserve", () -> client.post().uri("/reserve").contentType(MediaType.APPLICATION_JSON)
                        .header(Correlation.HEADER, requestId())
                        .body(Map.of("orderId", orderId, "items", lines)).retrieve().body(JsonNode.class));
                return new Reservation(j.path("reservationId").asText(), j.path("orderId").asText(), j.path("status").asText(),
                        j.path("created").asBoolean(), j.path("expiresAt").asText(null));
            } catch (Rejected e) {
                if ("insufficient_stock".equals(e.getCode())) {
                    List<Shortage> shortages = new ArrayList<>();
                    if (e.getDetails() != null) {
                        for (JsonNode d : e.getDetails()) {
                            shortages.add(new Shortage(d.path("productId").asText(), d.path("requested").asInt(),
                                    d.path("available").asInt(), d.path("shortBy").asInt(), d.path("reason").asText()));
                        }
                    }
                    throw new InsufficientStock(e.getMessage(), shortages);
                }
                throw e;
            }
        }

        /** Compensating action: give the hold back. Idempotent on Inventory's side. */
        public void release(String orderId) {
            try {
                call("release", () -> client.post().uri("/release").contentType(MediaType.APPLICATION_JSON)
                        .header(Correlation.HEADER, requestId())
                        .body(Map.of("orderId", orderId)).retrieve().body(JsonNode.class));
            } catch (Rejected e) {
                if (e.getStatus() == 404) {
                    return;   // no hold was ever taken for this order — nothing to release
                }
                throw e;
            }
        }
    }

    // -------------------------------------------------------------------------
    // PAYMENT — POST /payments, GET /payments/{orderId}  (services/payment/README.md)
    // -------------------------------------------------------------------------
    @Component
    public static class Payment extends ServiceClient {

        public record Created(String paymentId, String orderId, String status, boolean created, String razorpayOrderId,
                              String razorpayKeyId, long amountInPaise, String currency) {
        }

        public record Status(String paymentId, String orderId, String status, long amountInPaise, String currency,
                             String razorpayOrderId, String razorpayPaymentId, String failureReason) {
        }

        public Payment(OrderProperties p, ObjectMapper om) {
            super("payment", p.clients().paymentUrl(), p.clients().paymentTimeoutMs(), p.breaker(), om);
        }

        /** Server-to-server: OUR computed amount. 503 payment_gateway_unavailable / 502 payment_gateway_rejected → Rejected/Unavailable. */
        public Created create(String orderId, String userId, long amountInPaise, String currency) {
            JsonNode j = call("create", () -> client.post().uri("/payments").contentType(MediaType.APPLICATION_JSON)
                    .header(Correlation.HEADER, requestId())
                    .body(Map.of("orderId", orderId, "userId", userId, "amountInPaise", amountInPaise, "currency", currency))
                    .retrieve().body(JsonNode.class));
            return new Created(j.path("paymentId").asText(), j.path("orderId").asText(), j.path("status").asText(),
                    j.path("created").asBoolean(), j.path("razorpayOrderId").asText(null), j.path("razorpayKeyId").asText(null),
                    j.path("amountInPaise").asLong(), j.path("currency").asText());
        }

        /** Reconciliation: what Payment Service knows. Returns null when no payment exists for the order (404). */
        public Status status(String orderId) {
            try {
                JsonNode j = call("status", () -> client.get().uri("/payments/{orderId}", orderId)
                        .header(Correlation.HEADER, requestId()).retrieve().body(JsonNode.class));
                return new Status(j.path("paymentId").asText(), j.path("orderId").asText(), j.path("status").asText(),
                        j.path("amountInPaise").asLong(), j.path("currency").asText(), j.path("razorpayOrderId").asText(null),
                        j.path("razorpayPaymentId").asText(null), j.path("failureReason").asText(null));
            } catch (Rejected e) {
                if (e.getStatus() == 404) {
                    return null;
                }
                throw e;
            }
        }
    }
}
