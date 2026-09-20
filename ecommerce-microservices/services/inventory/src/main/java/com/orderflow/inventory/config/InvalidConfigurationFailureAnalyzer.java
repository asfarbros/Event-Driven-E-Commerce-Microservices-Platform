package com.orderflow.inventory.config;

import org.springframework.boot.diagnostics.AbstractFailureAnalyzer;
import org.springframework.boot.diagnostics.FailureAnalysis;

/**
 * Renders {@link InvalidConfigurationException} as Spring Boot's
 * "APPLICATION FAILED TO START" block — a readable list of what is missing,
 * instead of a stack trace. Registered in {@code META-INF/spring.factories}.
 */
public class InvalidConfigurationFailureAnalyzer extends AbstractFailureAnalyzer<InvalidConfigurationException> {

    @Override
    protected FailureAnalysis analyze(Throwable rootFailure, InvalidConfigurationException cause) {
        String description = "The Inventory Service refused to start because its configuration is invalid:\n\n  - "
                + String.join("\n  - ", cause.getProblems());
        String action = "Fix the variables above in the root .env (see .env.example, section "
                + "\"Inventory Service behaviour\") or in the process environment, then start again.";
        return new FailureAnalysis(description, action, cause);
    }
}
