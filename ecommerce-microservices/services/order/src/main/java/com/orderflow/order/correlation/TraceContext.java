package com.orderflow.order.correlation;

import java.util.HashMap;
import java.util.Map;

import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.propagation.W3CTraceContextPropagator;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.Scope;
import io.opentelemetry.context.propagation.TextMapGetter;

/**
 * Carries the W3C trace context ({@code traceparent}) ACROSS the outbox.
 *
 * <p>The outbox relay publishes on a scheduler thread, minutes or milliseconds
 * after the request that queued the row. Without this, the Kafka / RabbitMQ
 * publish spans would start a brand-new trace and the checkout trace would
 * stop at the database. So the writer stores the current span's
 * {@code traceparent} in the row, and the relay makes it current again while
 * publishing, so the OpenTelemetry Java agent's producer instrumentation
 * parents the publish span under the original request (and propagates it to
 * the consumers through the record / message headers).
 *
 * <p>With no agent on the classpath (host mode, tests) the API is a no-op:
 * {@link #current()} returns {@code null} and {@link #restore} is an empty scope.
 */
public final class TraceContext {

    private static final String TRACEPARENT = "traceparent";

    private TraceContext() {
    }

    /** {@code traceparent} of the current span, or null when there is no recording trace. */
    public static String current() {
        if (!Span.current().getSpanContext().isValid()) {
            return null;
        }
        Map<String, String> carrier = new HashMap<>();
        W3CTraceContextPropagator.getInstance().inject(Context.current(), carrier, (c, k, v) -> c.put(k, v));
        return carrier.get(TRACEPARENT);
    }

    /** Makes the stored trace context current for the duration of the returned scope. */
    public static Scope restore(String traceparent) {
        if (traceparent == null || traceparent.isBlank()) {
            return Scope.noop();
        }
        Map<String, String> carrier = Map.of(TRACEPARENT, traceparent);
        Context extracted = W3CTraceContextPropagator.getInstance().extract(Context.root(), carrier, new TextMapGetter<>() {
            @Override public Iterable<String> keys(Map<String, String> c) { return c.keySet(); }
            @Override public String get(Map<String, String> c, String key) { return c == null ? null : c.get(key); }
        });
        return extracted.makeCurrent();
    }
}
