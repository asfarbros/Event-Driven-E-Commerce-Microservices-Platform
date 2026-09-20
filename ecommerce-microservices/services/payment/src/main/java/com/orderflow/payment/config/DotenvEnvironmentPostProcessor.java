package com.orderflow.payment.config;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.apache.commons.logging.Log;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.env.EnvironmentPostProcessor;
import org.springframework.boot.logging.DeferredLogFactory;
import org.springframework.core.Ordered;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.MapPropertySource;

/**
 * Loads the ROOT {@code .env} the same way the Node services do with dotenv:
 * values become available to {@code ${...}} placeholders in application.yml,
 * but a real process environment variable always wins (the file is added with
 * the LOWEST precedence).
 *
 * Lookup order for the file:
 * <ol>
 *   <li>{@code DOTENV_CONFIG_PATH} (same override the Node services honour)</li>
 *   <li>{@code ./.env} — running from the project root</li>
 *   <li>{@code ../../.env} — running from {@code services/payment} (mvnw / IDE)</li>
 * </ol>
 * If none exists the service simply relies on the process environment (the
 * containerised setup in a later step), and {@link ConfigGuard} reports what
 * is missing.
 *
 * Registered in {@code META-INF/spring.factories}.
 */
public class DotenvEnvironmentPostProcessor implements EnvironmentPostProcessor, Ordered {

    public static final String PROPERTY_SOURCE_NAME = "orderflow-dotenv";
    static final String OVERRIDE_VARIABLE = "DOTENV_CONFIG_PATH";

    private final Log log;

    public DotenvEnvironmentPostProcessor(DeferredLogFactory logFactory) {
        this.log = logFactory.getLog(DotenvEnvironmentPostProcessor.class);
    }

    @Override
    public int getOrder() {
        // Run before ConfigDataEnvironmentPostProcessor so the file is in place
        // when application.yml placeholders are first resolved.
        return Ordered.HIGHEST_PRECEDENCE + 5;
    }

    @Override
    public void postProcessEnvironment(ConfigurableEnvironment environment, SpringApplication application) {
        Path file = locate(environment);
        if (file == null) {
            log.info("no .env file found (checked " + OVERRIDE_VARIABLE + ", ./.env, ../../.env) — using the process environment only");
            return;
        }
        try {
            Map<String, Object> values = parse(Files.readAllLines(file, StandardCharsets.UTF_8));
            environment.getPropertySources().addLast(new MapPropertySource(PROPERTY_SOURCE_NAME, values));
            log.info("loaded " + values.size() + " variables from " + file.toAbsolutePath().normalize()
                    + " (process environment takes precedence)");
        } catch (IOException e) {
            log.warn("could not read " + file + ": " + e.getMessage());
        }
    }

    private Path locate(ConfigurableEnvironment environment) {
        String override = environment.getProperty(OVERRIDE_VARIABLE);
        List<Path> candidates = override != null && !override.isBlank()
                ? List.of(Paths.get(override))
                : List.of(Paths.get(".env"), Paths.get("..", "..", ".env"));
        for (Path candidate : candidates) {
            if (Files.isRegularFile(candidate)) {
                return candidate;
            }
        }
        return null;
    }

    /**
     * Minimal dotenv grammar: {@code KEY=value}, blank lines and {@code #}
     * comments ignored, optional {@code export } prefix, surrounding single or
     * double quotes stripped (so {@code KAFKA_HEAP_OPTS="-Xms256m -Xmx512m"}
     * parses correctly). No interpolation — none of the values need it.
     */
    static Map<String, Object> parse(List<String> lines) {
        Map<String, Object> values = new LinkedHashMap<>();
        for (String raw : lines) {
            String line = raw.strip();
            if (line.isEmpty() || line.startsWith("#")) {
                continue;
            }
            if (line.startsWith("export ")) {
                line = line.substring("export ".length()).strip();
            }
            int eq = line.indexOf('=');
            if (eq <= 0) {
                continue;
            }
            String key = line.substring(0, eq).strip();
            String value = line.substring(eq + 1).strip();
            if (value.length() >= 2 && (value.startsWith("\"") && value.endsWith("\"")
                    || value.startsWith("'") && value.endsWith("'"))) {
                value = value.substring(1, value.length() - 1);
            } else {
                // Unquoted values may carry a trailing comment.
                int hash = value.indexOf(" #");
                if (hash >= 0) {
                    value = value.substring(0, hash).strip();
                }
            }
            values.put(key, value);
        }
        return values;
    }
}
