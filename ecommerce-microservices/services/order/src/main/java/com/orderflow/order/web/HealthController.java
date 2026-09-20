package com.orderflow.order.web;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import com.orderflow.order.clients.Clients;
import com.orderflow.order.clients.ServiceClient;
import com.orderflow.order.config.OrderProperties;
import com.orderflow.order.correlation.Correlation;
import com.orderflow.order.health.DatabaseHealth;
import com.orderflow.order.health.KafkaHealth;
import com.orderflow.order.health.RabbitHealth;
import com.orderflow.order.outbox.OutboxRelay;
import com.orderflow.order.service.OrderReconciliationJob;
import org.springframework.boot.info.BuildProperties;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * GET /health — always 200: db, kafka, rabbitmq, the four dependency circuit
 * breakers, the outbox (pending rows) and the reconciliation job.
 *   status = ok | degraded (a breaker not CLOSED, a topic missing, outbox backlog) | unhealthy (db, kafka or rabbitmq down)
 * GET /ready — 200 iff db AND kafka AND rabbitmq are reachable.
 */
@RestController
public class HealthController {

    private static final Instant STARTED_AT = Instant.now();

    public record HealthResponse(String status, String service, String version, long uptimeSeconds, Instant timestamp,
                                 Map<String, Object> db, Map<String, Object> kafka, Map<String, Object> rabbitmq,
                                 Map<String, Object> dependencies, Map<String, Object> outbox, Map<String, Object> reconciliation,
                                 String requestId) {
    }

    private final DatabaseHealth databaseHealth;
    private final KafkaHealth kafkaHealth;
    private final RabbitHealth rabbitHealth;
    private final List<ServiceClient> clients;
    private final OutboxRelay relay;
    private final Optional<OrderReconciliationJob> reconciliation;
    private final OrderProperties properties;
    private final String version;

    public HealthController(DatabaseHealth databaseHealth, KafkaHealth kafkaHealth, RabbitHealth rabbitHealth,
                            Clients.Cart cart, Clients.Catalog catalog, Clients.Inventory inventory, Clients.Payment payment,
                            OutboxRelay relay, Optional<OrderReconciliationJob> reconciliation, OrderProperties properties,
                            Optional<BuildProperties> build) {
        this.databaseHealth = databaseHealth;
        this.kafkaHealth = kafkaHealth;
        this.rabbitHealth = rabbitHealth;
        this.clients = List.of(cart, catalog, inventory, payment);
        this.relay = relay;
        this.reconciliation = reconciliation;
        this.properties = properties;
        this.version = build.map(BuildProperties::getVersion).orElse("dev");
    }

    @GetMapping("/health")
    public HealthResponse health() {
        return snapshot();
    }

    @GetMapping("/ready")
    public ResponseEntity<HealthResponse> ready() {
        HealthResponse body = snapshot();
        boolean ready = !"unhealthy".equals(body.status());
        return ResponseEntity.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE).body(body);
    }

    private HealthResponse snapshot() {
        DatabaseHealth.Status db = databaseHealth.check();
        KafkaHealth.Status kafka = kafkaHealth.check();
        RabbitHealth.Status rabbit = rabbitHealth.check();

        Map<String, Object> deps = new LinkedHashMap<>();
        boolean allClosed = true;
        for (ServiceClient c : clients) {
            deps.put(c.name(), Map.of("circuitBreaker", c.breakerState().name(),
                    "failureRatePercent", c.breakerMetrics().getFailureRate(), "bufferedCalls", c.breakerMetrics().getNumberOfBufferedCalls()));
            allClosed &= c.breakerState().name().equals("CLOSED");
        }
        long pending = db.connected() ? relay.pending() : -1;

        String status = !db.connected() || !kafka.connected() || !rabbit.connected() ? "unhealthy"
                : (kafka.allTopicsPresent() && allClosed && pending < 100 && "connected".equals(rabbit.state())) ? "ok" : "degraded";

        Map<String, Object> dbMap = new LinkedHashMap<>();
        dbMap.put("state", db.state());
        dbMap.put("database", db.database() != null ? db.database() : properties.dbName());
        dbMap.put("user", db.user());
        dbMap.put("schemaVersion", db.schemaVersion());
        dbMap.put("required", true);
        if (db.error() != null) dbMap.put("error", db.error());

        Map<String, Object> kafkaMap = new LinkedHashMap<>();
        kafkaMap.put("state", kafka.state());
        kafkaMap.put("bootstrapServers", kafka.bootstrapServers());
        kafkaMap.put("brokers", kafka.brokers());
        kafkaMap.put("consumerGroup", properties.kafka().consumerGroup());
        kafkaMap.put("topics", kafka.topics());
        kafkaMap.put("required", true);
        if (kafka.error() != null) kafkaMap.put("error", kafka.error());

        Map<String, Object> rabbitMap = new LinkedHashMap<>();
        rabbitMap.put("state", rabbit.state());
        rabbitMap.put("address", rabbit.address());
        rabbitMap.put("exchange", rabbit.exchange());
        rabbitMap.put("queue", rabbit.queue());
        rabbitMap.put("queueMessages", rabbit.queueMessages());
        rabbitMap.put("deadLetterQueue", rabbit.deadLetterQueue());
        rabbitMap.put("deadLetterMessages", rabbit.deadLetterMessages());
        rabbitMap.put("required", true);
        if (rabbit.error() != null) rabbitMap.put("error", rabbit.error());

        Map<String, Object> outboxMap = new LinkedHashMap<>();
        outboxMap.put("pending", pending);
        outboxMap.put("publishedSinceStart", relay.publishedTotal());
        outboxMap.put("relayIntervalMs", properties.outbox().relayIntervalMs());
        if (relay.lastError() != null) outboxMap.put("lastError", relay.lastError());

        Map<String, Object> recon = new LinkedHashMap<>();
        recon.put("enabled", reconciliation.isPresent());
        recon.put("intervalMs", properties.reconciliation().intervalMs());
        recon.put("stuckAfterMs", properties.reconciliation().stuckAfterMs());
        recon.put("abandonAfterMs", properties.reconciliation().abandonAfterMs());
        reconciliation.ifPresent(j -> {
            recon.put("lastRunAt", j.lastRunAt());
            recon.put("lastRunResolved", j.lastRunResolved());
            recon.put("totalResolved", j.totalResolved());
        });

        long uptime = Instant.now().getEpochSecond() - STARTED_AT.getEpochSecond();
        return new HealthResponse(status, "order", version, uptime, Instant.now(), dbMap, kafkaMap, rabbitMap, deps, outboxMap, recon,
                Correlation.current());
    }
}
