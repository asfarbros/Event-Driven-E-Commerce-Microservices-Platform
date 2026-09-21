-- Step 8: carry the W3C trace context across the outbox so the relay's
-- Kafka / RabbitMQ publish spans join the trace of the request that queued
-- the row (see correlation/TraceContext.java). Nullable: rows written without
-- an active trace (host mode, tests) simply start a new trace when published.
ALTER TABLE outbox_event ADD COLUMN trace_parent VARCHAR(64);
