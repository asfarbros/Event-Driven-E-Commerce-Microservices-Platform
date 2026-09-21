/**
 * Prometheus metrics (prom-client). One registry per process, exposed on
 * GET /metrics for the Step 8 Prometheus scrape.
 *
 * The HTTP histogram is deliberately named and labelled like Spring Boot's
 * (`http_server_requests_seconds{method,uri,status,outcome}`) so a single
 * Grafana query — rate(http_server_requests_seconds_count[1m]) by service —
 * covers the Node and the Java services alike. `uri` is the matched route
 * template (never the raw path, which would explode cardinality on ids).
 */
import client from 'prom-client';

export function createMetrics({ service }) {
  const registry = new client.Registry();
  registry.setDefaultLabels({ application: service });
  client.collectDefaultMetrics({ register: registry });

  const httpRequests = new client.Histogram({
    name: 'http_server_requests_seconds',
    help: 'HTTP server request duration in seconds',
    labelNames: ['method', 'uri', 'status', 'outcome'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });

  /** Express middleware: observe every response once it is finished. */
  function middleware() {
    return (req, res, next) => {
      const start = process.hrtime.bigint();
      res.on('finish', () => {
        const uri = routeTemplate(req);
        const status = String(res.statusCode);
        httpRequests.observe(
          { method: req.method, uri, status, outcome: outcomeOf(res.statusCode) },
          Number(process.hrtime.bigint() - start) / 1e9,
        );
      });
      next();
    };
  }

  /** GET /metrics handler. */
  async function handler(req, res) {
    res.setHeader('Content-Type', registry.contentType);
    res.end(await registry.metrics());
  }

  return { registry, client, httpRequests, middleware, handler };
}

function outcomeOf(status) {
  if (status >= 500) return 'SERVER_ERROR';
  if (status >= 400) return 'CLIENT_ERROR';
  if (status >= 300) return 'REDIRECTION';
  if (status >= 200) return 'SUCCESS';
  return 'INFORMATIONAL';
}

/** Route template if Express matched one; otherwise the first path segment(s) with ids collapsed. */
function routeTemplate(req) {
  if (req.route?.path) return `${req.baseUrl || ''}${req.route.path}`;
  const path = (req.originalUrl || req.url || '/').split('?')[0];
  // The gateway proxies without Express routes: keep the public prefix only (/api/catalog/…) → low cardinality.
  const m = path.match(/^\/api\/[^/]+/);
  if (m) return `${m[0]}/**`;
  return path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{24}|\d+/gi, ':id');
}
