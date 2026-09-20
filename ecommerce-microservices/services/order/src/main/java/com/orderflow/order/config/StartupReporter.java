package com.orderflow.order.config;

import javax.sql.DataSource;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.core.env.Environment;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import static net.logstash.logback.argument.StructuredArguments.kv;

/** Confirms the pool is really on order_db, then logs one line with every effective setting (no credentials). */
@Component
public class StartupReporter {

    private static final Logger log = LoggerFactory.getLogger(StartupReporter.class);

    private final DataSource dataSource;
    private final OrderProperties properties;
    private final Environment env;

    public StartupReporter(DataSource dataSource, OrderProperties properties, Environment env) {
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
            throw new IllegalStateException("connected to database \"" + database + "\" but this service owns \"" + properties.dbName() + "\" — refusing to run");
        }
        log.info("order service started",
                kv("port", env.getProperty("server.port")), kv("database", database), kv("dbUser", user),
                kv("cart", properties.clients().cartUrl()), kv("catalog", properties.clients().catalogUrl()),
                kv("inventory", properties.clients().inventoryUrl()), kv("payment", properties.clients().paymentUrl()),
                kv("priceChangePolicy", properties.priceChangePolicy()),
                kv("kafka", env.getProperty("spring.kafka.bootstrap-servers")), kv("consumerGroup", properties.kafka().consumerGroup()),
                kv("consumes", properties.kafka().paymentEventsTopic() + "," + properties.kafka().inventoryEventsTopic()),
                kv("publishes", properties.kafka().orderEventsTopic()),
                kv("rabbitExchange", properties.rabbit().exchange()), kv("rabbitQueue", properties.rabbit().queue()),
                kv("outboxRelayMs", properties.outbox().relayIntervalMs()),
                kv("reconcileIntervalMs", properties.reconciliation().intervalMs()), kv("profiles", String.join(",", env.getActiveProfiles())));
    }
}
