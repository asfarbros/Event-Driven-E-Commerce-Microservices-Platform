package com.orderflow.order.rabbit;

import java.util.Map;

import com.orderflow.order.config.OrderProperties;
import org.springframework.amqp.core.Binding;
import org.springframework.amqp.core.BindingBuilder;
import org.springframework.amqp.core.Declarables;
import org.springframework.amqp.core.Queue;
import org.springframework.amqp.core.QueueBuilder;
import org.springframework.amqp.core.TopicExchange;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * NOTIFICATION TOPOLOGY (also scripted in infra/rabbitmq/declare-topology.sh;
 * both are idempotent, declaring the same durable objects):
 *
 * <pre>
 *   exchange  notifications        (topic, durable)
 *      └─ binding  order.*  ──►  queue  notification.tasks   (durable, x-dead-letter-exchange = notifications.dlx)
 *   exchange  notifications.dlx    (topic, durable)
 *      └─ binding  #        ──►  queue  notification.tasks.dlq (durable)
 * </pre>
 *
 * Why RabbitMQ here and Kafka for the saga: a notification is a COMMAND —
 * "send this customer one e-mail" — a unit of work that exactly one worker
 * should perform, acknowledge when done, retry on failure and park in a
 * dead-letter queue when it keeps failing. RabbitMQ gives per-message acks,
 * redelivery and DLX natively. The saga's messages are EVENTS — "the order
 * was confirmed" — facts that several independent consumer groups (Inventory,
 * Payment, later analytics) each read at their own pace and can replay; that
 * is Kafka's durable, partitioned, per-group-offset log.
 *
 * The queue names come from the root .env (RABBITMQ_NOTIFICATION_*) so the
 * Step 7 worker and this producer agree by construction.
 */
@Configuration
public class RabbitTopology {

    @Bean
    public Declarables notificationTopology(OrderProperties properties) {
        OrderProperties.Rabbit r = properties.rabbit();
        TopicExchange exchange = new TopicExchange(r.exchange(), true, false);
        TopicExchange dlx = new TopicExchange(r.deadLetterExchange(), true, false);
        Queue queue = QueueBuilder.durable(r.queue())
                .withArguments(Map.of("x-dead-letter-exchange", r.deadLetterExchange()))
                .build();
        Queue dlq = QueueBuilder.durable(r.deadLetterQueue()).build();
        Binding tasks = BindingBuilder.bind(queue).to(exchange).with("order.*");
        Binding dead = BindingBuilder.bind(dlq).to(dlx).with("#");
        return new Declarables(exchange, dlx, queue, dlq, tasks, dead);
    }
}
