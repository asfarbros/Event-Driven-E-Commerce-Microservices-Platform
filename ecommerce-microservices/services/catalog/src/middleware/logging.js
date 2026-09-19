/**
 * One structured JSON line per request:
 * { requestId, req: { method, url }, res: { status }, durationMs, userId? }
 * `req.log` is bound to the same requestId for mid-request logging.
 */
import pinoHttp from 'pino-http';

export function requestLogging(logger) {
  return pinoHttp({
    logger,
    genReqId: (req) => req.id,
    customAttributeKeys: { reqId: 'requestId', responseTime: 'durationMs' },
    quietReqLogger: true,
    customLogLevel: (req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    customSuccessMessage: (req, res) => `${req.method} ${req.originalUrl} -> ${res.statusCode}`,
    customErrorMessage: (req, res) => `${req.method} ${req.originalUrl} -> ${res.statusCode}`,
    customProps: (req) => (req.userId ? { userId: req.userId } : {}),
    serializers: {
      req: (req) => ({ method: req.method, url: req.url, ip: req.remoteAddress }),
      res: (res) => ({ status: res.statusCode }),
      err: (err) => ({ type: err.type, message: err.message, code: err.code }),
    },
  });
}
