/**
 * Test fixture: a throwaway HTTP server that plays the role of a downstream
 * service. It reports exactly what it received (method, path, headers, body
 * size) so tests can assert on rewriting and header injection.
 *
 *   GET /anything?delay=500   → waits 500 ms before answering (timeout tests)
 *   POST /anything            → counts body bytes as they stream in
 *
 * Not a real service — never started outside the tests.
 */
import http from 'node:http';

export function startEchoServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://echo');
    const delay = Number(url.searchParams.get('delay') ?? 0);
    let bodyBytes = 0;
    req.on('data', (chunk) => { bodyBytes += chunk.length; });
    req.on('end', () => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-Echo': 'true' });
        res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, bodyBytes }));
      }, delay);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
      });
    });
  });
}
