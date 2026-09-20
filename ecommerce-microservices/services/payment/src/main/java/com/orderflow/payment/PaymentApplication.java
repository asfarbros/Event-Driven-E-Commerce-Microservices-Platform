package com.orderflow.payment;

import com.orderflow.payment.config.PaymentProperties;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * OrderFlow Payment Service — the single owner of money movement and the only
 * holder of Razorpay credentials. See README.md.
 */
@SpringBootApplication
@EnableScheduling
@EnableConfigurationProperties(PaymentProperties.class)
public class PaymentApplication {

    public static void main(String[] args) {
        SpringApplication.run(PaymentApplication.class, args);
    }
}
