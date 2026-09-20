package com.orderflow.order.kafka;

import java.nio.charset.StandardCharsets;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.orderflow.order.correlation.Correlation;
import com.orderflow.order.service.OrderService;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.common.header.Header;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.kafka.support.Acknowledgment;
import org.springframework.stereotype.Component;

import static net.logstash.logback.argument.StructuredArguments.kv;

/**
 * Consumes the two topics the saga answers on.
 *
 * <p>{@code payment-events} (Payment Service's documented contract):
 * {@code PaymentSucceeded} → order CONFIRMED + OrderConfirmed; {@code PaymentFailed}
 * → FAILED + OrderCancelled; {@code PaymentRefunded} → payment status REFUNDED.
 *
 * <p>{@code inventory-events} (Inventory's contract): {@code InventoryReleased}
 * with reason EXPIRED on an unpaid order → CANCELLED; {@code InventoryConfirmFailed}
 * (payment landed after the hold expired) → CANCELLED + refund;
 * {@code InventoryRestocked} (a cancelled paid order's units returned) → history
 * note. Other types are recorded and ignored.
 *
 * <p>Both envelopes carry {@code eventId} (the inbox key), {@code eventType},
 * {@code orderId} and the {@code X-Request-Id} header. Offsets are acked
 * manually after {@link OrderService#applyEvent} returned; a throw → retry
 * with backoff → that topic's dead-letter topic ({@link KafkaConsumerConfig}).
 */
@Component
public class SagaEventsListener {

    private static final Logger log = LoggerFactory.getLogger(SagaEventsListener.class);

    private final OrderService orderService;
    private final ObjectMapper objectMapper;

    public SagaEventsListener(OrderService orderService, ObjectMapper objectMapper) {
        this.orderService = orderService;
        this.objectMapper = objectMapper;
    }

    /** The subset of both envelopes this service reads. */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record SagaEvent(String eventId, String eventType, Integer version, String orderId, String reason, String failureReason) {
    }

    @KafkaListener(topics = "${order.kafka.payment-events-topic}", groupId = "${order.kafka.consumer-group}",
            autoStartup = "${order.kafka.consumer-enabled}")
    public void onPaymentEvent(ConsumerRecord<String, String> record, Acknowledgment ack) {
        handle(record, ack);
    }

    @KafkaListener(topics = "${order.kafka.inventory-events-topic}", groupId = "${order.kafka.consumer-group}",
            autoStartup = "${order.kafka.consumer-enabled}")
    public void onInventoryEvent(ConsumerRecord<String, String> record, Acknowledgment ack) {
        handle(record, ack);
    }

    private void handle(ConsumerRecord<String, String> record, Acknowledgment ack) {
        Correlation.set(correlationIdOf(record));
        try {
            SagaEvent event = parse(record);
            log.info("consuming " + event.eventType(), kv("topic", record.topic()), kv("orderId", event.orderId()),
                    kv("eventId", event.eventId()), kv("partition", record.partition()), kv("offset", record.offset()));
            String detail = event.failureReason() != null ? event.failureReason() : event.reason();
            orderService.applyEvent(record.topic(), event.eventId(), event.eventType(), event.orderId(), detail);
            ack.acknowledge();
        } finally {
            Correlation.clear();
        }
    }

    private SagaEvent parse(ConsumerRecord<String, String> record) {
        if (record.value() == null || record.value().isBlank()) {
            throw new MalformedEventException("empty record value");
        }
        SagaEvent event;
        try {
            event = objectMapper.readValue(record.value(), SagaEvent.class);
        } catch (Exception e) {
            throw new MalformedEventException("record value is not valid JSON for a saga event: " + e.getMessage());
        }
        if (event.eventType() == null || event.eventType().isBlank()) {
            throw new MalformedEventException("eventType is missing");
        }
        if (event.eventId() == null || event.eventId().isBlank() || event.eventId().length() > 128) {
            throw new MalformedEventException("eventId is missing or malformed");
        }
        if (event.orderId() == null || !event.orderId().matches("^[A-Za-z0-9._-]{1,64}$")) {
            throw new MalformedEventException("orderId is missing or malformed");
        }
        return event;
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
