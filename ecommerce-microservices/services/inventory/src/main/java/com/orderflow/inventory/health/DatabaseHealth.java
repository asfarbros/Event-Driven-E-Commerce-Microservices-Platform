package com.orderflow.inventory.health;

import javax.sql.DataSource;

import com.orderflow.inventory.config.InventoryProperties;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationInfo;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * PostgreSQL connectivity check for the explicit /health and /ready endpoints.
 * (Actuator's own "db" indicator covers /actuator/health.) Also reports which
 * database the pool is really connected to and the applied Flyway version, so
 * a misconfigured URL or a pending migration is visible at a glance.
 */
@Component
public class DatabaseHealth {

    private final JdbcTemplate jdbc;
    private final Flyway flyway;
    private final String expectedDatabase;

    public DatabaseHealth(DataSource dataSource, Flyway flyway, InventoryProperties properties) {
        this.jdbc = new JdbcTemplate(dataSource);
        this.jdbc.setQueryTimeout(2);
        this.flyway = flyway;
        this.expectedDatabase = properties.dbName();
    }

    public record Status(boolean connected, String state, String database, String user, String schemaVersion, String error) {
    }

    public Status check() {
        try {
            String database = jdbc.queryForObject("select current_database()", String.class);
            String user = jdbc.queryForObject("select current_user", String.class);
            MigrationInfo current = flyway.info().current();
            String version = current != null ? current.getVersion().getVersion() : "none";
            boolean ownDatabase = expectedDatabase.equals(database);
            return new Status(ownDatabase, ownDatabase ? "connected" : "wrong_database", database, user, version,
                    ownDatabase ? null : "connected to " + database + " but this service owns " + expectedDatabase);
        } catch (Exception e) {
            Throwable root = e;
            while (root.getCause() != null && root.getCause() != root) {
                root = root.getCause();
            }
            return new Status(false, "disconnected", null, null, null,
                    root.getClass().getSimpleName() + ": " + firstLine(root.getMessage()));
        }
    }

    private static String firstLine(String s) {
        if (s == null) return null;
        int nl = s.indexOf('\n');
        return nl >= 0 ? s.substring(0, nl) : s;
    }
}
