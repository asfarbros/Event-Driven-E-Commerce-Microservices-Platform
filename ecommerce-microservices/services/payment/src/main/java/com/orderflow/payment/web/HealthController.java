package com.orderflow.payment.web;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;

import com.orderflow.payment.config.PaymentProperties;
import com.orderflow.payment.correlation.Correlation;
import com.orderflow.payment.health.DatabaseHealth;
import com.orderflow.payment.health.KafkaHealth;
import com.orderflow.payment.razorpay.RazorpayGateway;
import com.orderflow.payment.service.ReconciliationJob;
import com.orderflow.payment.web.ApiDtos.HealthResponse;
import org.springframework.boot.info.BuildProperties;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * GET /health — liveness, always 200: db, kafka, the Razorpay circuit breaker
 * state and the reconciliation job. status = ok | degraded (breaker not
 * closed or a topic missing) | unhealthy (db or kafka down).
 * GET /ready — 200 iff db AND kafka are reachable. Razorpay is NOT required
 * for readiness: webhooks and reads must keep working while it is down.
 * Never includes credentials — only the key id's mode and the base URL.
 */
@RestController
public class HealthController {

    private static final Instant STARTED_AT = Instant.now();

    private final DatabaseHealth databaseHealth;
    private final KafkaHealth kafkaHealth;
    private final RazorpayGateway gateway;
    private final Optional<ReconciliationJob> reconciliation;
    private final PaymentProperties properties;
    private final String version;

    public HealthController(DatabaseHealth databaseHealth, KafkaHealth kafkaHealth, RazorpayGateway gateway,
                            Optional<ReconciliationJob> reconciliation, PaymentProperties properties, Optional<BuildProperties> build) {
        this.databaseHealth = databaseHealth;
        this.kafkaHealth = kafkaHealth;
        this.gateway = gateway;
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
        String breaker = gateway.breakerState().name();

        String status = !db.connected() || !kafka.connected() ? "unhealthy"
                : (kafka.allTopicsPresent() && "CLOSED".equals(breaker)) ? "ok" : "degraded";

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

        Map<String, Object> rzp = new LinkedHashMap<>();
        rzp.put("mode", properties.razorpay().isTestMode() ? "TEST" : "LIVE");
        rzp.put("keyId", properties.razorpay().keyId());
        rzp.put("baseUrl", properties.razorpay().baseUrl());
        rzp.put("timeoutMs", properties.razorpay().timeoutMs());
        rzp.put("circuitBreaker", breaker);
        rzp.put("failureRatePercent", gateway.breakerMetrics().getFailureRate());
        rzp.put("bufferedCalls", gateway.breakerMetrics().getNumberOfBufferedCalls());
        rzp.put("required", false);

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
        return new HealthResponse(status, "payment", version, uptime, Instant.now(), dbMap, kafkaMap, rzp, recon, Correlation.current());
    }
}
