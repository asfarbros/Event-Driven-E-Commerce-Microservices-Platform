/**
 * In-process counters reported by /health. Reset on restart (they describe
 * this instance, not the system); the durable truth is the queues themselves
 * and the dedupe ledger.
 */
export function createMetrics() {
  const counters = {
    received: 0,       // deliveries handed to us by RabbitMQ (incl. retries + duplicates)
    sent: 0,           // notifications actually delivered by the channel
    duplicates: 0,     // acked without sending because the messageId was already sent
    retried: 0,        // moved to a retry queue after a transient failure
    deadLettered: 0,   // parked in the DLQ (exhausted + unprocessable)
    unprocessable: 0,  // subset of deadLettered: malformed / can never succeed
    requeued: 0,       // handed back to the broker unacked (connection lost mid-flight)
  };
  let inFlight = 0;
  return {
    counters,
    inc(name, by = 1) { counters[name] += by; },
    begin() { inFlight += 1; },
    end() { inFlight -= 1; },
    get inFlight() { return inFlight; },
    snapshot() { return { ...counters, inFlight }; },
  };
}
