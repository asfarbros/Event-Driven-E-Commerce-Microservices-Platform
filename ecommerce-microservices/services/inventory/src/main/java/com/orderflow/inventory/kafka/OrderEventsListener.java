package com.orderflow.inventory.kafka;

import java.nio.charset.StandardCharsets;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.orderflow.inventory.correlation.Correlation;
import com.orderflow.inventory.service.InventoryService;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.common.header.Header;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.kafka.support.Acknowledgment;
import org.springframework.stereotype.Component;

import static net.logstash.logback.argument.StructuredArguments.kv;

/**
 * Consumes {@code order-events}.
 *
 * <p>Expected envelope (Order Service, Step 6, publishes this; unknown extra
 * fields are ignored, unknown event types are skipped):
 * <pre>
 * { "eventType": "OrderConfirmed" | "OrderCancelled", "version": 1,
 *   "eventId": "…", "orderId": "…", "occurredAt": "…" }
 * </pre>
 * with the {@code X-Request-Id} header carrying the correlation id.
 *
 * <ul>
 *   <li>OrderConfirmed → the hold becomes a permanent deduction (CONFIRMED).</li>
 *   <li>OrderCancelled → a HELD hold is released back to available (RELEASED);
 *       a CONFIRMED hold — the order was paid and is being refunded — is
 *       RESTOCKED (sold units come back to available).</li>
 * </ul>
 *
 * <p><b>Idempotent:</b> the service checks the reservation's status under a
 * row lock, so the same event delivered twice changes nothing the second time.
 *
 * <p><b>Offsets:</b> acknowledged manually, only after the service call
 * returned. If it throws, no ack — {@link KafkaConsumerConfig} retries with
 * backoff and finally parks the record on the dead-letter topic, after which
 * the offset is committed so the partition keeps flowing.
 */
@Component
public class OrderEventsListener {

    private static final Logger log = LoggerFactory.getLogger(OrderEventsListener.class);

    public static final String ORDER_CONFIRMED = "OrderConfirmed";
    public static final String ORDER_CANCELLED = "OrderCancelled";

    private final InventoryService inventoryService;
    private final ObjectMapper objectMapper;

    public OrderEventsListener(InventoryService inventoryService, ObjectMapper objectMapper) {
        this.inventoryService = inventoryService;
        this.objectMapper = objectMapper;
    }

    /** The subset of the order-events envelope this service reads. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record OrderEvent(String eventType, Integer version, String eventId, String orderId, String occurredAt) {
    }

    @KafkaListener(
            topics = "${inventory.kafka.order-events-topic}",
            groupId = "${inventory.kafka.consumer-group}",
            autoStartup = "${inventory.kafka.consumer-enabled}")
    public void onOrderEvent(ConsumerRecord<String, String> record, Acknowledgment ack) {
        Correlation.set(correlationIdOf(record));
        try {
            OrderEvent event = parse(record);
            switch (event.eventType()) {
                case ORDER_CONFIRMED -> {
                    log.info("consuming OrderConfirmed", kv("orderId", event.orderId()), kv("eventId", event.eventId()),
                            kv("partition", record.partition()), kv("offset", record.offset()));
                    inventoryService.confirm(event.orderId());
                }
                case ORDER_CANCELLED -> {
                    log.info("consuming OrderCancelled", kv("orderId", event.orderId()), kv("eventId", event.eventId()),
                            kv("partition", record.partition()), kv("offset", record.offset()));
                    // HELD -> release (unpaid order); CONFIRMED -> restock (paid order being refunded); else no-op.
                    inventoryService.handleOrderCancelled(event.orderId());
                }
                default -> log.debug("ignoring order event of another type", kv("eventType", event.eventType()),
                        kv("orderId", event.orderId()), kv("offset", record.offset()));
            }
            ack.acknowledge();
        } finally {
            Correlation.clear();
        }
    }

    private OrderEvent parse(ConsumerRecord<String, String> record) {
        if (record.value() == null || record.value().isBlank()) {
            throw new MalformedEventException("empty record value");
        }
        OrderEvent event;
        try {
            event = objectMapper.readValue(record.value(), OrderEvent.class);
        } catch (Exception e) {
            throw new MalformedEventException("record value is not valid JSON for an order event: " + e.getMessage());
        }
        if (event.eventType() == null || event.eventType().isBlank()) {
            throw new MalformedEventException("eventType is missing");
        }
        boolean needsOrderId = ORDER_CONFIRMED.equals(event.eventType()) || ORDER_CANCELLED.equals(event.eventType());
        if (needsOrderId && !isValidId(event.orderId())) {
            throw new MalformedEventException("orderId is missing or malformed for " + event.eventType());
        }
        return event;
    }

    private static boolean isValidId(String id) {
        return id != null && id.matches("^[A-Za-z0-9._-]{1,64}$");
    }

    static String correlationIdOf(ConsumerRecord<?, ?> record) {
        Header header = record.headers().lastHeader(Correlation.HEADER);
        if (header != null && header.value() != null) {
            String value = new String(header.value(), StandardCharsets.UTF_8);
            if (Correlation.isValid(value)) {
                return value;
            }
        }
        return Correlation.newId("evt");
    }
}
