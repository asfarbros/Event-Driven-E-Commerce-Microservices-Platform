package com.orderflow.order.health;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;

import com.orderflow.order.config.OrderProperties;
import jakarta.annotation.PreDestroy;
import org.apache.kafka.clients.admin.AdminClient;
import org.apache.kafka.clients.admin.DescribeClusterResult;
import org.apache.kafka.clients.admin.ListTopicsOptions;
import org.springframework.boot.actuate.health.Health;
import org.springframework.boot.actuate.health.HealthIndicator;
import org.springframework.kafka.core.KafkaAdmin;
import org.springframework.stereotype.Component;

/**
 * Kafka connectivity check. Spring Boot has no built-in Kafka health
 * indicator, so this one asks the broker to describe the cluster (bounded by a
 * short timeout) and verifies that the three topics this service depends on
 * exist — topic auto-creation is OFF, so a missing topic is the most likely
 * misconfiguration and it shows up here as {@code degraded} rather than as a
 * failed publish later.
 *
 * <p>Registered as an Actuator {@link HealthIndicator} (component "kafka" in
 * /actuator/health) and used directly by the explicit /health and /ready
 * endpoints.
 */
@Component("kafka")
public class KafkaHealth implements HealthIndicator {

    private static final long TIMEOUT_MS = 2_000;

    private final KafkaAdmin kafkaAdmin;
    private final String bootstrapServers;
    private final List<String> requiredTopics;
    private volatile AdminClient adminClient;

    public KafkaHealth(KafkaAdmin kafkaAdmin, OrderProperties properties) {
        this.kafkaAdmin = kafkaAdmin;
        this.bootstrapServers = String.valueOf(kafkaAdmin.getConfigurationProperties().get("bootstrap.servers"));
        this.requiredTopics = List.of(properties.kafka().orderEventsTopic(), properties.kafka().paymentEventsTopic(),
                properties.kafka().inventoryEventsTopic(), properties.kafka().paymentEventsDlt(), properties.kafka().inventoryEventsDlt());
    }

    /** Snapshot for the explicit health endpoints. */
    public record Status(boolean connected, String state, String bootstrapServers, String clusterId,
                         Integer brokers, Map<String, Boolean> topics, boolean allTopicsPresent, String error) {
    }

    public Status check() {
        try {
            AdminClient client = client();
            DescribeClusterResult cluster = client.describeCluster();
            int brokers = cluster.nodes().get(TIMEOUT_MS, TimeUnit.MILLISECONDS).size();
            String clusterId = cluster.clusterId().get(TIMEOUT_MS, TimeUnit.MILLISECONDS);
            Set<String> existing = client.listTopics(new ListTopicsOptions().timeoutMs((int) TIMEOUT_MS))
                    .names().get(TIMEOUT_MS, TimeUnit.MILLISECONDS);
            Map<String, Boolean> topics = new LinkedHashMap<>();
            for (String topic : requiredTopics) {
                topics.put(topic, existing.contains(topic));
            }
            boolean all = topics.values().stream().allMatch(Boolean::booleanValue);
            return new Status(true, "connected", bootstrapServers, clusterId, brokers, topics, all, null);
        } catch (Exception e) {
            Throwable root = e;
            while (root.getCause() != null && root.getCause() != root) {
                root = root.getCause();
            }
            return new Status(false, "disconnected", bootstrapServers, null, null, Map.of(), false,
                    root.getClass().getSimpleName() + ": " + root.getMessage());
        }
    }

    @Override
    public Health health() {
        Status s = check();
        Health.Builder b = s.connected ? (s.allTopicsPresent ? Health.up() : Health.status("DEGRADED")) : Health.down();
        b.withDetail("bootstrapServers", s.bootstrapServers).withDetail("topics", s.topics);
        if (s.clusterId != null) {
            b.withDetail("clusterId", s.clusterId).withDetail("brokers", s.brokers);
        }
        if (s.error != null) {
            b.withDetail("error", s.error);
        }
        return b.build();
    }

    private AdminClient client() {
        AdminClient c = adminClient;
        if (c == null) {
            synchronized (this) {
                if (adminClient == null) {
                    Map<String, Object> config = new LinkedHashMap<>(kafkaAdmin.getConfigurationProperties());
                    config.put("request.timeout.ms", (int) TIMEOUT_MS);
                    config.put("default.api.timeout.ms", (int) TIMEOUT_MS);
                    adminClient = AdminClient.create(config);
                }
                c = adminClient;
            }
        }
        return c;
    }

    @PreDestroy
    void close() {
        AdminClient c = adminClient;
        if (c != null) {
            c.close();
        }
    }
}
