package com.orderflow.inventory.service;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import com.orderflow.inventory.domain.ReservationStatus;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** Pins the inventory-events contract that Order Service (Step 6) will code against. */
class InventoryEventTest {

    private final ObjectMapper mapper = new ObjectMapper().registerModule(new JavaTimeModule())
            .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);

    private final ReservationView view = new ReservationView(UUID.randomUUID(), "ord-1", ReservationStatus.HELD,
            Instant.parse("2026-09-20T10:25:30Z"), Instant.parse("2026-09-20T10:15:30Z"), null,
            List.of(new ReservationView.Line("p1", 2), new ReservationView.Line("p2", 1)));

    @Test
    void reservedEventCarriesTheDocumentedFields() throws Exception {
        JsonNode json = mapper.readTree(mapper.writeValueAsString(InventoryEvent.reserved(view, "req-123")));

        assertThat(json.get("eventType").asText()).isEqualTo("InventoryReserved");
        assertThat(json.get("version").asInt()).isEqualTo(1);
        assertThat(json.get("source").asText()).isEqualTo("inventory");
        assertThat(json.get("correlationId").asText()).isEqualTo("req-123");
        assertThat(json.get("orderId").asText()).isEqualTo("ord-1");
        assertThat(json.get("reservationId").asText()).isEqualTo(view.id().toString());
        assertThat(json.get("expiresAt").asText()).isEqualTo("2026-09-20T10:25:30Z");
        assertThat(json.get("eventId").asText()).isNotBlank();
        assertThat(json.get("occurredAt").asText()).isNotBlank();
        assertThat(json.get("items")).hasSize(2);
        assertThat(json.get("items").get(0).get("productId").asText()).isEqualTo("p1");
        assertThat(json.get("items").get(0).get("quantity").asInt()).isEqualTo(2);
        assertThat(json.has("reason")).as("reason is absent unless relevant").isFalse();
    }

    @Test
    void releasedEventCarriesTheReasonAndNoExpiry() throws Exception {
        JsonNode json = mapper.readTree(mapper.writeValueAsString(
                InventoryEvent.released(view, InventoryEvent.ReleaseReason.EXPIRED, "sweep-1")));

        assertThat(json.get("eventType").asText()).isEqualTo("InventoryReleased");
        assertThat(json.get("reason").asText()).isEqualTo("EXPIRED");
        assertThat(json.has("expiresAt")).isFalse();
    }

    @Test
    void confirmFailedReportsTheHoldStatusAsReason() {
        ReservationView expired = new ReservationView(view.id(), "ord-1", ReservationStatus.EXPIRED, view.expiresAt(),
                view.createdAt(), Instant.now(), view.items());
        InventoryEvent event = InventoryEvent.confirmFailed(expired, "req-9");
        assertThat(event.eventType()).isEqualTo("InventoryConfirmFailed");
        assertThat(event.reason()).isEqualTo("EXPIRED");
    }
}
