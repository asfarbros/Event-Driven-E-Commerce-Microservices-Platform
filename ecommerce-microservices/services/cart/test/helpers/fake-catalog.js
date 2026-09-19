/**
 * Test fixture: a stand-in for the Catalog service's bulk price endpoint,
 * fully controllable from the tests.
 *
 *   fixture.products     Map<productId, { name, sku, priceInPaise, currency, isActive }>
 *   fixture.mode         'ok' (answer) | 'hang' (never answer) | 'error' (500)
 *   fixture.calls        every request: { productIds, requestId }
 *
 * Contract mirrored from services/catalog: POST /products/prices →
 * { prices: [...], unavailable: [{ productId, reason }], asOf }.
 */
import http from 'node:http';

export function startFakeCatalog() {
  const fixture = { products: new Map(), mode: 'ok', calls: [] };
  const pending = new Set();

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/products/prices') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'not_found' }));
      }
      const { productIds } = JSON.parse(raw);
      fixture.calls.push({ productIds, requestId: req.headers['x-request-id'] });

      if (fixture.mode === 'hang') { pending.add(res); return; }
      if (fixture.mode === 'error') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'internal_error' }));
      }
      const prices = [];
      const unavailable = [];
      for (const id of new Set(productIds)) {
        const p = fixture.products.get(id);
        if (!p) unavailable.push({ productId: id, reason: 'not_found' });
        else if (!p.isActive) unavailable.push({ productId: id, reason: 'inactive' });
        else prices.push({ productId: id, sku: p.sku, name: p.name, priceInPaise: p.priceInPaise, currency: p.currency });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ prices, unavailable, asOf: new Date().toISOString() }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        fixture,
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => { for (const res of pending) res.destroy(); server.closeAllConnections(); server.close(r); }),
      });
    });
  });
}
