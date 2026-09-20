package com.orderflow.order;

import com.orderflow.order.config.OrderProperties;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.scheduling.annotation.EnableScheduling;

/** OrderFlow Order Service — owns the order lifecycle and orchestrates checkout. See README.md. */
@SpringBootApplication
@EnableScheduling
@EnableConfigurationProperties(OrderProperties.class)
public class OrderApplication {

    public static void main(String[] args) {
        SpringApplication.run(OrderApplication.class, args);
    }
}
