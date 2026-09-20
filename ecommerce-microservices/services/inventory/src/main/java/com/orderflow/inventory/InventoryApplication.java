package com.orderflow.inventory;

import com.orderflow.inventory.config.InventoryProperties;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * OrderFlow Inventory Service — the single owner of stock.
 *
 * See README.md for the two-number stock model, the locking strategy, the
 * REST and Kafka contracts and the expiry sweeper.
 */
@SpringBootApplication
@EnableScheduling
@EnableConfigurationProperties(InventoryProperties.class)
public class InventoryApplication {

    public static void main(String[] args) {
        ConfigurableApplicationContext context = SpringApplication.run(InventoryApplication.class, args);
        // Seed mode (profile "seed", see scripts/seed.sh) is a one-shot command:
        // the runner has finished by now, so exit with its code.
        if (context.getEnvironment().getProperty("inventory.seed.enabled", Boolean.class, false)) {
            System.exit(SpringApplication.exit(context));
        }
    }
}
