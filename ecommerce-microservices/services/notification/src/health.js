/**
 * Minimal internal HTTP endpoint (plain node:http — no framework for two
 * routes). NOT routed through the API Gateway; used by Compose healthchecks
 * and demos.
 *
 *   GET /health  always 200. status:
 *       ok         connected + consuming, ledger connected
 *       degraded   consuming but the ledger is down (deliveries are retried,
 *                  not sent un-deduplicated), or reconnecting
 *       unhealthy  not consuming and not reconnecting
 *   GET /ready    200 iff consuming, 503 otherwise
 *   GET /metrics  Prometheus: process defaults + the counters below as
 *                 notification_messages_total{outcome} and gauges for
 *                 in-flight deliveries and the RabbitMQ connection state
 */
import http from 'node:http';
import client from 'prom-client';
import { describeConnection } from './db/mongo.js';

const startedAt = Date.now();

export function createHealthServer({ config, version, instance, worker, metrics, channel, recipients, ledger, logger }) {
  const log = logger.child({ component: 'health' });

  const registry = new client.Registry();
  registry.setDefaultLabels({ application: 'notification', instance_id: instance });
  client.collectDefaultMetrics({ register: registry });
  const messages = new client.Gauge({ name: 'notification_messages_total', help: 'Deliveries by outcome since start', labelNames: ['outcome'], registers: [registry] });
  const inFlight = new client.Gauge({ name: 'notification_in_flight', help: 'Deliveries currently being processed', registers: [registry] });
  const connected = new client.Gauge({ name: 'notification_rabbitmq_connected', help: '1 when consuming, else 0', registers: [registry] });
  async function metricsText() {
    const c = metrics.snapshot();
    for (const k of ['received', 'sent', 'duplicates', 'retried', 'deadLettered', 'unprocessable', 'requeued']) messages.set({ outcome: k }, c[k]);
    inFlight.set(c.inFlight);
    connected.set(worker.describe().consumer.active ? 1 : 0);
    return registry.metrics();
  }

  function snapshot() {
    const rabbit = worker.describe();
    const db = describeConnection();
    let status = 'unhealthy';
    if (rabbit.connected && rabbit.consumer.active) status = db.connected ? 'ok' : 'degraded';
    else if (rabbit.state === 'reconnecting' || rabbit.state === 'connecting') status = 'degraded';
    return {
      status,
      service: 'notification',
      version,
      instance,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      timestamp: new Date().toISOString(),
      rabbitmq: rabbit,
      ledger: { ...db, required: true, ...ledger.describe() },
      channel: channel.describe(),
      recipients: recipients.describe(),
      counters: metrics.snapshot(),
    };
  }

  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'GET') return send(405, { error: 'method_not_allowed' });
    if (url === '/health') return send(200, snapshot());
    if (url === '/metrics') return metricsText().then((text) => { res.writeHead(200, { 'Content-Type': registry.contentType }); res.end(text); });
    if (url === '/ready') { const s = snapshot(); return send(s.rabbitmq.consumer.active ? 200 : 503, s); }
    return send(404, { error: 'not_found', message: 'this worker exposes only GET /health, GET /ready and GET /metrics' });
  });

  const listening = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '0.0.0.0', () => { server.off('error', reject); resolve(server.address()); });
  });

  async function close() {
    await new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
    log.info('health endpoint closed');
  }

  return { listening, close, snapshot };
}
