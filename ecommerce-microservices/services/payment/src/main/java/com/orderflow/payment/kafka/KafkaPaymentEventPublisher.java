package com.orderflow.payment.kafka;

import java.nio.charset.StandardCharsets;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.orderflow.payment.config.PaymentProperties;
import com.orderflow.payment.correlation.Correlation;
import com.orderflow.payment.service.PaymentEvent;
import com.orderflow.payment.service.PaymentEventPublisher;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Component;

import static net.logstash.logback.argument.StructuredArguments.kv;

/**
 * Publishes {@link PaymentEvent}s to {@code payment-events}.
 *
 * <p>Record layout (the contract Order Service consumes in Step 6; same layout as inventory-events):
 * <ul>
 *   <li><b>key</b> — {@code orderId}, so every event about one order lands on
 *       the same partition and is consumed in order.</li>
 *   <li><b>value</b> — the JSON envelope documented on {@link PaymentEvent}.</li>
 *   <li><b>headers</b> —
 *     {@code X-Request-Id} (correlation id of the originating request — the
 *     same value the REST response carried, so one user action can be traced
 *     across REST and Kafka), {@code X-Event-Type}, {@code X-Event-Id},
 *     {@code X-Event-Version}, {@code X-Source}, {@code Content-Type}.</li>
 * </ul>
 *
 * <p>Sends are asynchronous with acks=all and an idempotent producer. The
 * HTTP response never waits on the broker: the database is the source of
 * truth, and a failed send is logged as an error with the ids needed to
 * replay it. (A transactional outbox would close that gap; it is deliberately
 * out of scope for this step.)
 */
@Component
public class KafkaPaymentEventPublisher implements PaymentEventPublisher {

    private static final Logger log = LoggerFactory.getLogger(KafkaPaymentEventPublisher.class);

    public static final String HEADER_EVENT_TYPE = "X-Event-Type";
    public static final String HEADER_EVENT_ID = "X-Event-Id";
    public static final String HEADER_EVENT_VERSION = "X-Event-Version";
    public static final String HEADER_SOURCE = "X-Source";
    public static final String HEADER_CONTENT_TYPE = "Content-Type";

    private final KafkaTemplate<String, String> kafkaTemplate;
    private final ObjectMapper objectMapper;
    private final String topic;

    public KafkaPaymentEventPublisher(KafkaTemplate<String, String> kafkaTemplate, ObjectMapper objectMapper,
                                        PaymentProperties properties) {
        this.kafkaTemplate = kafkaTemplate;
        this.objectMapper = objectMapper;
        this.topic = properties.kafka().paymentEventsTopic();
    }

    @Override
    public void publish(PaymentEvent event) {
        String correlationId = event.correlationId() != null ? event.correlationId() : Correlation.current();
        String json;
        try {
            json = objectMapper.writeValueAsString(event);
        } catch (JsonProcessingException e) {
            log.error("could not serialise event — NOT published", kv("eventType", event.eventType()),
                    kv("orderId", event.orderId()), e);
            return;
        }

        ProducerRecord<String, String> record = new ProducerRecord<>(topic, event.orderId(), json);
        record.headers()
                .add(Correlation.HEADER, bytes(correlationId))
                .add(HEADER_EVENT_TYPE, bytes(event.eventType()))
                .add(HEADER_EVENT_ID, bytes(event.eventId()))
                .add(HEADER_EVENT_VERSION, bytes(Integer.toString(event.version())))
                .add(HEADER_SOURCE, bytes(PaymentEvent.SOURCE))
                .add(HEADER_CONTENT_TYPE, bytes("application/json"));

        // The callback runs on the producer's I/O thread, where the MDC is
        // empty, so the correlation id is passed explicitly.
        kafkaTemplate.send(record).whenComplete((result, ex) -> {
            if (ex != null) {
                log.error("event publish FAILED", kv(Correlation.MDC_KEY, correlationId), kv("topic", topic),
                        kv("eventType", event.eventType()), kv("eventId", event.eventId()), kv("orderId", event.orderId()), ex);
            } else {
                var meta = result.getRecordMetadata();
                log.info("event published", kv(Correlation.MDC_KEY, correlationId), kv("topic", topic),
                        kv("partition", meta.partition()), kv("offset", meta.offset()),
                        kv("eventType", event.eventType()), kv("eventId", event.eventId()), kv("orderId", event.orderId()));
            }
        });
    }

    private static byte[] bytes(String s) {
        return s.getBytes(StandardCharsets.UTF_8);
    }
}
