package com.orderflow.inventory.web;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;

import com.orderflow.inventory.config.InventoryProperties;
import com.orderflow.inventory.correlation.Correlation;
import com.orderflow.inventory.health.DatabaseHealth;
import com.orderflow.inventory.health.KafkaHealth;
import com.orderflow.inventory.service.ExpirySweeper;
import com.orderflow.inventory.web.ApiDtos.HealthResponse;
import org.springframework.boot.info.BuildProperties;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * GET /health — liveness, always 200. Reports PostgreSQL (required), Kafka
 * (required) and the sweeper, so "up but degraded" is visible.
 *   status: ok         db + kafka connected, all topics present
 *           degraded   connected but a required topic is missing
 *           unhealthy  db or kafka unreachable
 * GET /ready — readiness: 200 iff db AND kafka are connected, else 503.
 *
 * /actuator/health exposes the same facts in Actuator's format.
 */
@RestController
public class HealthController {

    private static final Instant STARTED_AT = Instant.now();

    private final DatabaseHealth databaseHealth;
    private final KafkaHealth kafkaHealth;
    private final Optional<ExpirySweeper> sweeper;
    private final InventoryProperties properties;
    private final String version;

    public HealthController(DatabaseHealth databaseHealth, KafkaHealth kafkaHealth, Optional<ExpirySweeper> sweeper,
                            InventoryProperties properties, Optional<BuildProperties> build) {
        this.databaseHealth = databaseHealth;
        this.kafkaHealth = kafkaHealth;
        this.sweeper = sweeper;
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

        String status = !db.connected() || !kafka.connected() ? "unhealthy" : kafka.allTopicsPresent() ? "ok" : "degraded";

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
        kafkaMap.put("clusterId", kafka.clusterId());
        kafkaMap.put("brokers", kafka.brokers());
        kafkaMap.put("consumerGroup", properties.kafka().consumerGroup());
        kafkaMap.put("topics", kafka.topics());
        kafkaMap.put("required", true);
        if (kafka.error() != null) kafkaMap.put("error", kafka.error());

        Map<String, Object> sweeperMap = new LinkedHashMap<>();
        sweeperMap.put("enabled", sweeper.isPresent());
        sweeperMap.put("intervalMs", properties.sweeper().intervalMs());
        sweeperMap.put("holdDurationMs", properties.holdDurationMs());
        sweeper.ifPresent(s -> {
            sweeperMap.put("lastRunAt", s.lastRunAt());
            sweeperMap.put("lastRunReleased", s.lastRunReleased());
            sweeperMap.put("totalReleased", s.totalReleased());
        });

        long uptime = Instant.now().getEpochSecond() - STARTED_AT.getEpochSecond();
        return new HealthResponse(status, "inventory", version, uptime, Instant.now(), dbMap, kafkaMap, sweeperMap,
                Correlation.current());
    }
}
