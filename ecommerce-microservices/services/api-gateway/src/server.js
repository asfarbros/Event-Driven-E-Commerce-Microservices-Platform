/**
 * HTTP server lifecycle: start, and shut down gracefully.
 *
 * shutdown():
 *   1. stop accepting new connections (server.close)
 *   2. close idle keep-alive connections immediately
 *   3. let in-flight requests finish, up to `shutdownTimeoutMs`
 *   4. after the deadline, force-close whatever is left
 * Resolves with the exit code the caller should use (0 clean, 1 forced).
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
        logger.info('all connections closed');
        resolve(0);
      });
      server.closeIdleConnections();
    });
    return shuttingDown;
  };

  return { server, listening, shutdown };
}
