/**
 * One structured JSON line per request, e.g.
 * { "requestId": "…", "req": { "method": "GET", "url": "/api/catalog/x" },
 *   "res": { "status": 200 }, "durationMs": 14, "upstream": "catalog" }
 * `req.log` is a child logger bound to the same requestId, so anything a
 * middleware logs mid-request carries the correlation id too.
 */
import pinoHttp from 'pino-http';

export function requestLogging(logger) {
  return pinoHttp({
    logger,
    genReqId: (req) => req.id, // set by requestContext()
    customAttributeKeys: { reqId: 'requestId', responseTime: 'durationMs' },
    quietReqLogger: true, // bind requestId on req.log instead of the full req object
    customLogLevel: (req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    customSuccessMessage: (req, res) => `${req.method} ${req.originalUrl} -> ${res.statusCode}`,
    customErrorMessage: (req, res) => `${req.method} ${req.originalUrl} -> ${res.statusCode}`,
    customProps: (req) => ({
      ...(req.userId ? { userId: req.userId } : {}),
      ...(req.proxiedService ? { upstream: req.proxiedService } : {}),
    }),
    serializers: {
      req: (req) => ({ method: req.method, url: req.url, ip: req.remoteAddress }),
      res: (res) => ({ status: res.statusCode }),
      err: (err) => ({ type: err.type, message: err.message, code: err.code }),
    },
  });
}
