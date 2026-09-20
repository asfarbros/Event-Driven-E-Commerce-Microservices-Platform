package com.orderflow.order.kafka;

import com.orderflow.order.config.OrderProperties;
import com.orderflow.order.correlation.Correlation;
import java.util.Map;

import org.apache.kafka.common.TopicPartition;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.kafka.listener.CommonErrorHandler;
import org.springframework.kafka.listener.DeadLetterPublishingRecoverer;
import org.springframework.kafka.listener.DefaultErrorHandler;
import org.springframework.kafka.listener.ConsumerRecordRecoverer;
import org.springframework.kafka.support.ExponentialBackOffWithMaxRetries;

import static net.logstash.logback.argument.StructuredArguments.kv;

/**
 * Error handling for the payment-events / inventory-events consumers (same
 * policy as Inventory and Payment): retry with exponential backoff, then
 * dead-letter to THAT topic's own DLT.
 *
 * <pre>
 *   attempt 1 fails → wait initial → attempt 2 fails → wait ×multiplier → …
 *   after ORDER_KAFKA_RETRY_MAX_ATTEMPTS retries → record copied to the
 *   DEAD LETTER TOPIC (KAFKA_TOPIC_*_ORDER_DLT), its offset is
 *   committed, and the partition moves on to the next record.
 * </pre>
 *
 * Retrying happens in-place (the consumer seeks back to the record), so the
 * partition IS paused for the duration of the backoff — that is the price of
 * preserving per-order ordering — but it is bounded: a poison message can
 * delay its partition by at most the sum of the backoffs, never block it.
 *
 * <p>Classification:
 * <ul>
 *   <li>{@link MalformedEventException} (not JSON, missing fields) — retrying
 *       cannot help, so it goes to the DLT immediately.</li>
 *   <li>Everything else — database unavailable, lock timeout, an event for an
 *       order this service does not know yet ({@code UnknownOrderException}) or
 *       whose checkout has not reached the needed state ({@code OrderNotReadyException})
 *       — retried, then parked. Retrying is SAFE: processed_event and the state
 *       machine make re-application a no-op.</li>
 * </ul>
 *
 * <p>The DLT record keeps the original key, value and headers (including
 * {@code X-Request-Id}) and gains Spring's {@code kafka_dlt-*} headers with
 * the original topic/partition/offset, the exception class and message.
 */
@Configuration
public class KafkaConsumerConfig {

    private static final Logger log = LoggerFactory.getLogger(KafkaConsumerConfig.class);

    @Bean
    public CommonErrorHandler kafkaErrorHandler(KafkaTemplate<String, String> kafkaTemplate, OrderProperties properties) {
        // One dead-letter topic PER CONSUMED TOPIC: payment-events.order.dlt / inventory-events.order.dlt.
        Map<String, String> dlt = Map.of(
                properties.kafka().paymentEventsTopic(), properties.kafka().paymentEventsDlt(),
                properties.kafka().inventoryEventsTopic(), properties.kafka().inventoryEventsDlt());
        OrderProperties.Retry retry = properties.kafka().retry();

        DeadLetterPublishingRecoverer recoverer = new DeadLetterPublishingRecoverer(kafkaTemplate,
                // Same partition number as the source so per-order ordering survives into the DLT
                // (the DLT is created with the same partition count).
                (record, ex) -> new TopicPartition(dlt.getOrDefault(record.topic(), record.topic() + ".order.dlt"), record.partition()));
        recoverer.setFailIfSendResultIsError(true);

        // Logs the terminal outcome, then delegates to the DLT publisher.
        ConsumerRecordRecoverer loggingRecoverer = (record, ex) -> {
            log.error("order event DEAD-LETTERED after exhausting retries",
                    kv(Correlation.MDC_KEY, SagaEventsListener.correlationIdOf(record)),
                    kv("deadLetterTopic", dlt.get(record.topic())), kv("sourceTopic", record.topic()),
                    kv("partition", record.partition()), kv("offset", record.offset()), kv("key", record.key()),
                    kv("error", rootMessage(ex)));
            recoverer.accept(record, ex);
        };

        ExponentialBackOffWithMaxRetries backOff = new ExponentialBackOffWithMaxRetries(retry.maxAttempts());
        backOff.setInitialInterval(retry.initialIntervalMs());
        backOff.setMultiplier(retry.multiplier());
        backOff.setMaxInterval(retry.maxIntervalMs());

        DefaultErrorHandler handler = new DefaultErrorHandler(loggingRecoverer, backOff);
        handler.addNotRetryableExceptions(MalformedEventException.class);
        handler.setAckAfterHandle(true);
        handler.setRetryListeners((record, ex, attempt) -> log.warn("order event attempt failed",
                kv(Correlation.MDC_KEY, SagaEventsListener.correlationIdOf(record)),
                kv("attempt", attempt), kv("maxRetries", retry.maxAttempts()),
                kv("topic", record.topic()), kv("partition", record.partition()), kv("offset", record.offset()),
                kv("error", rootMessage(ex))));
        handler.setLogLevel(org.springframework.kafka.KafkaException.Level.WARN);
        return handler;
    }

    static String rootMessage(Throwable ex) {
        Throwable t = ex;
        while (t.getCause() != null && t.getCause() != t) {
            t = t.getCause();
        }
        return t.getClass().getSimpleName() + ": " + t.getMessage();
    }
}
