package com.orderflow.order.outbox;

import java.time.Clock;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.orderflow.order.config.OrderProperties;
import com.orderflow.order.correlation.Correlation;
import com.orderflow.order.domain.Order;
import com.orderflow.order.domain.OrderItem;
import com.orderflow.order.domain.OutboxEvent;
import com.orderflow.order.domain.OrderRepository;
import com.orderflow.order.domain.OutboxRepository;
import com.orderflow.order.domain.ProcessedEventRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import static net.logstash.logback.argument.StructuredArguments.kv;

/**
 * Writes outbox rows. MUST be called inside the transaction that changes the
 * order — that is the whole point: the state change and the message it
 * requires either both commit or neither does.
 *
 * <h3>order-events contract (what Inventory and Payment consume)</h3>
 * Both services documented the envelope they read:
 * {@code { eventType, version, eventId, orderId, occurredAt }} with the
 * {@code X-Request-Id} header, record key = orderId, and both declare
 * {@code @JsonIgnoreProperties(ignoreUnknown = true)}. The envelope below
 * carries exactly those fields (same names, same types) plus informational
 * extras ({@code source, correlationId, userId, status, totalInPaise,
 * currency, reason, items}) that they ignore and Step 7 may use. Headers
 * match Inventory's/Payment's own producers: {@code X-Request-Id,
 * X-Event-Type, X-Event-Id, X-Event-Version, X-Source, Content-Type}.
 * <pre>
 * { "eventType": "OrderCreated" | "OrderConfirmed" | "OrderCancelled", "version": 1, "eventId": "uuid",
 *   "orderId": "uuid", "occurredAt": "ISO-8601", "source": "order", "correlationId": "…",
 *   "userId": "…", "status": "CONFIRMED", "totalInPaise": 129900, "currency": "INR",
 *   "reason": "…" (OrderCancelled only),
 *   "items": [ { "productId": "…", "sku": "…", "quantity": 2, "unitPriceInPaise": 64950 } ] }
 * </pre>
 *
 * <h3>Notification COMMAND (RabbitMQ, consumed by the Step 7 worker)</h3>
 * Exchange {@code notifications} (topic), routing key {@code order.confirmed}
 * / {@code order.cancelled}. AMQP properties: {@code messageId} (stable —
 * {@code notify-<orderId>-<routingKey>} — the consumer's dedupe key),
 * {@code correlationId}, {@code type} (= commandType), {@code contentType
 * application/json}, persistent delivery, header {@code X-Request-Id}. Body:
 * <pre>
 * { "messageId": "notify-<orderId>-order.confirmed", "commandType": "SendOrderConfirmation" | "SendOrderCancellation",
 *   "version": 1, "source": "order", "occurredAt": "…", "correlationId": "…",
 *   "orderId": "…", "userId": "…", "status": "CONFIRMED", "totalInPaise": 129900, "currency": "INR",
 *   "reason": "…" (cancellation only), "items": [ { "productId", "sku", "name", "quantity", "unitPriceInPaise", "lineTotalInPaise" } ] }
 * </pre>
 * The command is a request to DO something for one customer (send an e-mail),
 * so it goes on the task queue, not the event log.
 */
@Component
public class OutboxWriter {

    private static final Logger log = LoggerFactory.getLogger(OutboxWriter.class);

    public static final String ORDER_CREATED = "OrderCreated";
    public static final String ORDER_CONFIRMED = "OrderConfirmed";
    public static final String ORDER_CANCELLED = "OrderCancelled";
    public static final String ROUTING_CONFIRMED = "order.confirmed";
    public static final String ROUTING_CANCELLED = "order.cancelled";
    public static final int SCHEMA_VERSION = 1;
    public static final String SOURCE = "order";

    private final OutboxRepository outbox;
    private final ObjectMapper objectMapper;
    private final OrderProperties properties;
    private final Clock clock;

    public OutboxWriter(OutboxRepository outbox, ObjectMapper objectMapper, OrderProperties properties, Clock clock) {
        this.outbox = outbox;
        this.objectMapper = objectMapper;
        this.properties = properties;
        this.clock = clock;
    }

    /** Kafka order-events. A fresh eventId per call: each call is a distinct fact. */
    public OutboxEvent orderEvent(Order order, String eventType, String reason) {
        String eventId = UUID.randomUUID().toString();
        String correlationId = Correlation.current();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("eventType", eventType);
        body.put("version", SCHEMA_VERSION);
        body.put("eventId", eventId);
        body.put("orderId", order.getId().toString());
        body.put("occurredAt", clock.instant().toString());
        body.put("source", SOURCE);
        body.put("correlationId", correlationId);
        body.put("userId", order.getUserId());
        body.put("status", order.getStatus().name());
        body.put("totalInPaise", order.getTotalInPaise());
        body.put("currency", order.getCurrency());
        if (reason != null) {
            body.put("reason", reason);
        }
        body.put("items", order.getItems().stream().map(i -> Map.of(
                "productId", i.getProductId(), "sku", i.getSku(), "quantity", i.getQuantity(), "unitPriceInPaise", i.getUnitPriceInPaise())).toList());
        OutboxEvent row = new OutboxEvent(order.getId().toString(), OutboxEvent.Destination.KAFKA,
                properties.kafka().orderEventsTopic(), order.getId().toString(), eventType, eventId, json(body), correlationId, clock.instant());
        outbox.save(row);
        log.info("outbox: queued order event", kv("orderId", order.getId()), kv("eventType", eventType), kv("eventId", eventId));
        return row;
    }

    /**
     * RabbitMQ notification command. The message id is DETERMINISTIC per
     * (order, routing key) and UNIQUE in the outbox, so a second decision to
     * notify for the same reason is silently collapsed into the first.
     */
    public void notification(Order order, String routingKey, String commandType, String reason) {
        String messageId = "notify-" + order.getId() + "-" + routingKey;
        String correlationId = Correlation.current();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("messageId", messageId);
        body.put("commandType", commandType);
        body.put("version", SCHEMA_VERSION);
        body.put("source", SOURCE);
        body.put("occurredAt", clock.instant().toString());
        body.put("correlationId", correlationId);
        body.put("orderId", order.getId().toString());
        body.put("userId", order.getUserId());
        body.put("status", order.getStatus().name());
        body.put("totalInPaise", order.getTotalInPaise());
        body.put("currency", order.getCurrency());
        if (reason != null) {
            body.put("reason", reason);
        }
        body.put("items", order.getItems().stream().map(OutboxWriter::itemMap).toList());
        if (outbox.existsByMessageId(messageId)) {
            // Already queued by another path (a replayed event, reconciliation, ...). Exactly one command per (order, reason).
            // outbox_message_id_unique is the backstop for a concurrent race.
            log.info("outbox: notification already queued — not duplicated", kv("orderId", order.getId()), kv("messageId", messageId));
            return;
        }
        OutboxEvent row = new OutboxEvent(order.getId().toString(), OutboxEvent.Destination.RABBITMQ,
                properties.rabbit().exchange(), routingKey, commandType, messageId, json(body), correlationId, clock.instant());
        outbox.save(row);
        log.info("outbox: queued notification command", kv("orderId", order.getId()), kv("routingKey", routingKey), kv("messageId", messageId));
    }

    private static Map<String, Object> itemMap(OrderItem i) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("productId", i.getProductId());
        m.put("sku", i.getSku());
        m.put("name", i.getName());
        m.put("quantity", i.getQuantity());
        m.put("unitPriceInPaise", i.getUnitPriceInPaise());
        m.put("lineTotalInPaise", i.getLineTotalInPaise());
        return m;
    }

    private String json(Map<String, Object> body) {
        try {
            return objectMapper.writeValueAsString(body);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("could not serialise outbox payload", e);
        }
    }
}
