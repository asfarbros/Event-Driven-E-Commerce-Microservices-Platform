package com.orderflow.payment.config;

import javax.sql.DataSource;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.core.env.Environment;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import static net.logstash.logback.argument.StructuredArguments.kv;

/**
 * After start-up: confirm the pool really is connected to payment_db (the URL
 * was checked textually; this asks the server), then log ONE line with every
 * effective setting. Credentials are never part of it — only the key id's
 * mode (test/live) and the API base URL.
 */
@Component
public class StartupReporter {

    private static final Logger log = LoggerFactory.getLogger(StartupReporter.class);

    private final DataSource dataSource;
    private final PaymentProperties properties;
    private final Environment env;

    public StartupReporter(DataSource dataSource, PaymentProperties properties, Environment env) {
        this.dataSource = dataSource;
        this.properties = properties;
        this.env = env;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void onReady() {
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        String database = jdbc.queryForObject("select current_database()", String.class);
        String user = jdbc.queryForObject("select current_user", String.class);
        if (!properties.dbName().equals(database)) {
            throw new IllegalStateException("connected to database \"" + database + "\" but this service owns \""
                    + properties.dbName() + "\" — refusing to run");
        }
        log.info("payment service started",
                kv("port", env.getProperty("server.port")),
                kv("database", database), kv("dbUser", user),
                kv("razorpayMode", properties.razorpay().isTestMode() ? "TEST" : "LIVE"),
                kv("razorpayKeyId", properties.razorpay().keyId()),
                kv("razorpayBaseUrl", properties.razorpay().baseUrl()),
                kv("razorpayTimeoutMs", properties.razorpay().timeoutMs()),
                kv("kafka", env.getProperty("spring.kafka.bootstrap-servers")),
                kv("consumerGroup", properties.kafka().consumerGroup()),
                kv("consumes", properties.kafka().orderEventsTopic()),
                kv("publishes", properties.kafka().paymentEventsTopic()),
                kv("deadLetterTopic", properties.kafka().deadLetterTopic()),
                kv("reconcileIntervalMs", properties.reconciliation().intervalMs()),
                kv("reconcileStuckAfterMs", properties.reconciliation().stuckAfterMs()),
                kv("profiles", String.join(",", env.getActiveProfiles())));
    }
}
