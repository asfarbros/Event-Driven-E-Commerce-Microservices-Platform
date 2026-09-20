package com.orderflow.order.health;



import com.orderflow.order.config.OrderProperties;
import org.springframework.amqp.rabbit.connection.ConnectionFactory;
import org.springframework.amqp.rabbit.core.RabbitAdmin;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.stereotype.Component;

/**
 * RabbitMQ connectivity for /health and /ready: opens a channel and asks the
 * broker for the notification queue (which also verifies the topology was
 * declared). Actuator's own "rabbit" indicator covers /actuator/health.
 */
@Component
public class RabbitHealth {

    private final RabbitTemplate rabbitTemplate;
    private final RabbitAdmin rabbitAdmin;
    private final OrderProperties.Rabbit config;
    private final String address;

    public RabbitHealth(RabbitTemplate rabbitTemplate, ConnectionFactory connectionFactory, OrderProperties properties) {
        this.rabbitTemplate = rabbitTemplate;
        this.rabbitAdmin = new RabbitAdmin(connectionFactory);
        this.config = properties.rabbit();
        this.address = connectionFactory.getHost() + ":" + connectionFactory.getPort();
    }

    public record Status(boolean connected, String state, String address, String exchange, String queue,
                         Integer queueMessages, String deadLetterQueue, Integer deadLetterMessages, String error) {
    }

    public Status check() {
        try {
            java.util.Properties q = rabbitAdmin.getQueueProperties(config.queue());
            java.util.Properties dlq = rabbitAdmin.getQueueProperties(config.deadLetterQueue());
            if (q == null) {
                return new Status(true, "queue_missing", address, config.exchange(), config.queue(), null, config.deadLetterQueue(), null,
                        "queue " + config.queue() + " is not declared");
            }
            return new Status(true, "connected", address, config.exchange(), config.queue(),
                    ((Number) q.get(RabbitAdmin.QUEUE_MESSAGE_COUNT)).intValue(), config.deadLetterQueue(),
                    dlq != null ? ((Number) dlq.get(RabbitAdmin.QUEUE_MESSAGE_COUNT)).intValue() : null, null);
        } catch (Exception e) {
            Throwable root = e;
            while (root.getCause() != null && root.getCause() != root) {
                root = root.getCause();
            }
            return new Status(false, "disconnected", address, config.exchange(), config.queue(), null, config.deadLetterQueue(), null,
                    root.getClass().getSimpleName() + ": " + root.getMessage());
        }
    }
}
