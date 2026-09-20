package com.orderflow.order.outbox;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.orderflow.order.config.OrderProperties;
import com.orderflow.order.domain.Order;
import com.orderflow.order.domain.OrderStatus;
import com.orderflow.order.domain.OutboxEvent;
import com.orderflow.order.domain.OutboxRepository;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Pins the outbound contracts: order-events must carry exactly the fields
 * Inventory and Payment documented that they read; the notification command
 * must carry a deterministic message id.
 */
class OutboxContractTest {

    private final ObjectMapper mapper = new ObjectMapper();
    private final OutboxRepository repo = mock(OutboxRepository.class);
    private final OrderProperties props = new OrderProperties("order_db", OrderProperties.PriceChangePolicy.PROCEED, 20, 100,
            null, null, null, null,
            new OrderProperties.Kafka(true, "order-events", "payment-events", "inventory-events", "p.dlt", "i.dlt", "order-service", null),
            new OrderProperties.Rabbit("notifications", "notification.tasks", "notifications.dlx", "notification.tasks.dlq", 5000));
    private final OutboxWriter writer = new OutboxWriter(repo, mapper, props, Clock.fixed(Instant.parse("2026-09-20T10:00:00Z"), ZoneOffset.UTC));

    private Order paidOrder() {
        Order o = new Order("user_1", "INR", null, null, "req-1");
        o.addItem("p1", "SKU-1", "Thing", 2, 12500L);
        o.recordPlaced("req-1");
        o.transitionTo(OrderStatus.RESERVED, Order.Trigger.CHECKOUT, "", null, "r");
        o.transitionTo(OrderStatus.AWAITING_PAYMENT, Order.Trigger.CHECKOUT, "", null, "r");
        o.transitionTo(OrderStatus.CONFIRMED, Order.Trigger.PAYMENT_EVENT, "", "e", "r");
        return o;
    }

    @Test
    void orderEventMatchesWhatInventoryAndPaymentConsume() throws Exception {
        Order o = paidOrder();
        OutboxEvent row = writer.orderEvent(o, OutboxWriter.ORDER_CONFIRMED, null);

        assertThat(row.getDestination()).isEqualTo(OutboxEvent.Destination.KAFKA);
        assertThat(row.getTarget()).isEqualTo("order-events");
        assertThat(row.getRoutingKey()).as("record key = orderId").isEqualTo(o.getId().toString());
        JsonNode json = mapper.readTree(row.getPayload());
        // The five fields Inventory's and Payment's OrderEvent records read, by name and type:
        assertThat(json.get("eventType").asText()).isEqualTo("OrderConfirmed");
        assertThat(json.get("version").asInt()).isEqualTo(1);
        assertThat(json.get("eventId").asText()).isEqualTo(row.getMessageId());
        assertThat(json.get("orderId").asText()).isEqualTo(o.getId().toString());
        assertThat(json.get("occurredAt").asText()).isEqualTo("2026-09-20T10:00:00Z");
        // Extras they ignore (ignoreUnknown = true) but Step 7 may use:
        assertThat(json.get("source").asText()).isEqualTo("order");
        assertThat(json.get("totalInPaise").isIntegralNumber()).isTrue();
        assertThat(json.get("items").get(0).get("unitPriceInPaise").asLong()).isEqualTo(12500L);
        verify(repo).save(any(OutboxEvent.class));
    }

    @Test
    void notificationCommandHasADeterministicMessageIdAndIsNotDuplicated() throws Exception {
        Order o = paidOrder();
        when(repo.existsByMessageId(anyString())).thenReturn(false);
        writer.notification(o, OutboxWriter.ROUTING_CONFIRMED, "SendOrderConfirmation", null);

        ArgumentCaptor<OutboxEvent> captor = ArgumentCaptor.forClass(OutboxEvent.class);
        verify(repo).save(captor.capture());
        OutboxEvent row = captor.getValue();
        assertThat(row.getDestination()).isEqualTo(OutboxEvent.Destination.RABBITMQ);
        assertThat(row.getTarget()).isEqualTo("notifications");
        assertThat(row.getRoutingKey()).isEqualTo("order.confirmed");
        assertThat(row.getMessageId()).isEqualTo("notify-" + o.getId() + "-order.confirmed");
        JsonNode json = mapper.readTree(row.getPayload());
        assertThat(json.get("commandType").asText()).isEqualTo("SendOrderConfirmation");
        assertThat(json.get("messageId").asText()).isEqualTo(row.getMessageId());
        assertThat(json.get("items").get(0).get("lineTotalInPaise").asLong()).isEqualTo(25000L);

        // Second decision to notify for the same reason → nothing new is written.
        OutboxRepository repo2 = mock(OutboxRepository.class);
        when(repo2.existsByMessageId(row.getMessageId())).thenReturn(true);
        new OutboxWriter(repo2, mapper, props, Clock.systemUTC()).notification(o, OutboxWriter.ROUTING_CONFIRMED, "SendOrderConfirmation", null);
        verify(repo2, never()).save(any());
    }
}
