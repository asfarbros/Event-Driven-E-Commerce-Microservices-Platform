/**
 * HTTP server lifecycle — same as the gateway's server.js. shutdown() stops
 * accepting connections, closes idle keep-alives, waits for in-flight
 * requests up to the grace period, then force-closes. Resolves with the exit
 * code to use (0 clean, 1 forced). Closing MongoDB is the caller's job, after
 * the HTTP side is done (index.js).
 */
import http from 'node:http';

export function startServer(app, { port, host = '0.0.0.0', shutdownTimeoutMs }, logger) {
  const server = http.createServer(app);

  const listening = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });

  let shuttingDown = null;
  const shutdown = (reason = 'shutdown') => {
    if (shuttingDown) return shuttingDown;
    shuttingDown = new Promise((resolve) => {
      logger.info({ reason, graceMs: shutdownTimeoutMs }, 'shutting down: no longer accepting connections');
      const deadline = setTimeout(() => {
        logger.warn('grace period elapsed; closing remaining connections');
        server.closeAllConnections();
        resolve(1);
      }, shutdownTimeoutMs);
      deadline.unref();
      server.close(() => {
        clearTimeout(deadline);
        clearInterval(sweep);
        logger.info('all connections closed');
        resolve(0);
      });
      // Keep-alive sockets that become idle AFTER close() was called are not
      // reaped by Node on their own; sweep them so draining finishes as soon
      // as the last in-flight response is written, not at the deadline.
      server.closeIdleConnections();
      const sweep = setInterval(() => server.closeIdleConnections(), 100);
      sweep.unref();
    });
    return shuttingDown;
  };

  return { server, listening, shutdown };
}
