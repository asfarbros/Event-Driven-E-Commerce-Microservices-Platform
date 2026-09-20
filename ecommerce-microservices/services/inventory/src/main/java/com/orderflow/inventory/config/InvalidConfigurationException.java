package com.orderflow.inventory.config;

import java.util.List;

/** Thrown by {@link ConfigGuard}; carries every problem found so all can be shown at once. */
public class InvalidConfigurationException extends RuntimeException {

    private final List<String> problems;

    public InvalidConfigurationException(List<String> problems) {
        super("Invalid configuration:\n  - " + String.join("\n  - ", problems));
        this.problems = List.copyOf(problems);
    }

    public List<String> getProblems() {
        return problems;
    }
}
