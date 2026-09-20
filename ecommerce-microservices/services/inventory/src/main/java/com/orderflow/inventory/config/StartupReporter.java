package com.orderflow.inventory.config;

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
 * After the context is up: verify the pool is REALLY connected to the owned
 * database (the JDBC URL was checked textually by ConfigGuard; this asks the
 * server), then log one line with every effective setting — the line a demo
 * starts from.
 */
@Component
public class StartupReporter {

    private static final Logger log = LoggerFactory.getLogger(StartupReporter.class);

    private final DataSource dataSource;
    private final InventoryProperties properties;
    private final Environment env;

    public StartupReporter(DataSource dataSource, InventoryProperties properties, Environment env) {
        this.dataSource = dataSource;
        this.properties = properties;
        this.env = env;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void onReady() {
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        String database = jdbc.queryForObject("select current_database()", String.class);
        String user = jdbc.queryForObject("select current_user", String.class);
        String lockTimeout = jdbc.queryForObject("show lock_timeout", String.class);
        if (!properties.dbName().equals(database)) {
            throw new IllegalStateException("connected to database \"" + database + "\" but this service owns \""
                    + properties.dbName() + "\" — refusing to run");
        }

        boolean seedMode = properties.seed().enabled();
        log.info(seedMode ? "inventory seed mode" : "inventory service started",
                kv("port", env.getProperty("server.port")),
                kv("database", database), kv("dbUser", user), kv("lockTimeout", lockTimeout),
                kv("kafka", env.getProperty("spring.kafka.bootstrap-servers")),
                kv("consumerGroup", properties.kafka().consumerGroup()),
                kv("consumes", properties.kafka().orderEventsTopic()),
                kv("publishes", properties.kafka().inventoryEventsTopic()),
                kv("deadLetterTopic", properties.kafka().deadLetterTopic()),
                kv("holdDurationMs", properties.holdDurationMs()),
                kv("sweeperEnabled", properties.sweeper().enabled()),
                kv("sweeperIntervalMs", properties.sweeper().intervalMs()),
                kv("profiles", String.join(",", env.getActiveProfiles())));
    }
}
