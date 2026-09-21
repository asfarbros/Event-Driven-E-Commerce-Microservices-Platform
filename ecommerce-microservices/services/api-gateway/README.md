# API Gateway

The single public entry point for OrderFlow. Browsers only ever talk to this
process; it never contains business logic and never touches a database, Kafka
or RabbitMQ. It does exactly four things:

1. **CORS** — only origins listed in `CORS_ALLOWED_ORIGINS` may read responses.
2. **Authentication** — verifies the Clerk session JWT on protected routes.
3. **Routing** — maps a path prefix to a downstream service (route table below).
4. **Proxying** — streams the request to that service and the response back,
   injecting `X-User-Id` (verified identity) and `X-Request-Id` (correlation).

Stack: Node.js 20+ · Express 5 · `http-proxy-middleware` 3 · `@clerk/express` 2
(`clerkMiddleware()` + `getAuth()`; not the deprecated `@clerk/clerk-sdk-node`) ·
`helmet` · `express-rate-limit` · `pino`. **ESM throughout** (`"type": "module"`).

## Run it

```bash
cd services/api-gateway
npm install
npm start                # reads ../../.env, listens on GATEWAY_PORT
npm run dev              # same, restarts on file changes
npm test                 # integration tests (no external services needed)
npm start | npx pino-pretty   # human-readable logs
```

The gateway starts and stays healthy even when **every** downstream service is
down — you only get a `503` when you call one of their routes.

```bash
curl -i http://localhost:4000/health
```

## Route table

Defined once in [`src/config/routes.js`](src/config/routes.js). Everything else
(env validation, auth, proxying, logging) derives from it.

| Prefix           | Service   | Env var                 | Auth | Rewrite        | Example                                      |
| ---------------- | --------- | ----------------------- | ---- | -------------- | -------------------------------------------- |
| `/health`        | gateway   | —                       | no   | —              | handled locally, never proxied               |
| `/api/catalog`   | catalog   | `CATALOG_SERVICE_URL`   | no   | strip-prefix   | `/api/catalog/products/7` → `/products/7`    |
| `/api/cart`      | cart      | `CART_SERVICE_URL`      | yes  | strip-prefix   | `/api/cart/items` → `/items`                 |
| `/api/orders`    | orders    | `ORDER_SERVICE_URL`     | yes  | strip-prefix   | `/api/orders/42` → `/42`                     |
| `/api/payments`  | payments  | `PAYMENT_SERVICE_URL`   | yes  | strip-prefix   | `/api/payments/verify` → `/verify`           |
| `/api/payment-webhooks` | payment-webhooks | `PAYMENT_SERVICE_URL` | **no** — Razorpay sends no JWT; Payment verifies the HMAC signature over the raw body | custom | `/api/payment-webhooks/razorpay` → `/webhooks/razorpay` |
| `/api/inventory` | inventory | `INVENTORY_SERVICE_URL` | yes  | strip-prefix   | `/api/inventory/stock/7` → `/stock/7`        |

Rules that apply to every entry:

- Prefix matching is segment-safe: `/api/cart` matches `/api/cart` and
  `/api/cart/…`, never `/api/cartography`.
- `strip-prefix` removes the prefix and keeps everything else, including the
  query string; the bare prefix forwards as `/`.
- Anything not in the table is `404 { "error": "not_found" }`.

### Adding a service later

1. Add one line to `routes.js`:
   ```js
   { name: 'reviews', prefix: '/api/reviews', targetEnv: 'REVIEWS_SERVICE_URL', auth: true, rewrite: 'strip-prefix' },
   ```
2. Add `REVIEWS_SERVICE_URL=http://localhost:4004` to the root `.env` and
   `.env.example`.

That's it. The gateway refuses to start if the variable is missing, and the
route table itself is validated at boot (duplicate or nested prefixes fail fast).

## What a downstream service receives

| Header            | Set by the gateway                                              |
| ----------------- | --------------------------------------------------------------- |
| `X-User-Id`       | Clerk user id — **only** on `auth: true` routes, after verification |
| `X-Session-Id`    | Clerk session id, same condition                                |
| `X-Request-Id`    | Correlation id (reused from the client if well-formed, else a UUID) |
| `X-Forwarded-For` / `-Proto` / `-Host` | Original client information                |
| `Host`            | Rewritten to the target service                                 |

**Spoofing guard:** any `X-User-Id` / `X-Session-Id` sent by a client is deleted
at the edge (`request-context.js`) and again on the outgoing request
(`create-proxy.js`). Services may trust `X-User-Id` precisely because only the
gateway can set it — so they must never be reachable except through the gateway.

## Errors

Every error is JSON with the same shape, never HTML or a stack trace:

```json
{ "error": "unauthorized", "message": "Invalid or expired token", "requestId": "…" }
```

| Status | `error`               | When                                                        |
| ------ | --------------------- | ----------------------------------------------------------- |
| 401    | `unauthorized`        | Protected route with no / malformed / expired / forged token |
| 403    | `origin_not_allowed`  | CORS preflight from an origin not in `CORS_ALLOWED_ORIGINS`  |
| 404    | `not_found`           | No route matches                                            |
| 413    | `payload_too_large`   | `Content-Length` above `GATEWAY_BODY_LIMIT`                 |
| 429    | `rate_limited`        | More than `GATEWAY_RATE_LIMIT_MAX` requests per window      |
| 503    | `service_unavailable` | Downstream unreachable or slower than `GATEWAY_PROXY_TIMEOUT_MS` (message names the service, never its address) |
| 500    | `internal_error`      | Anything unexpected (details only in the logs)              |

A plain (non-preflight) request from a disallowed origin is answered normally
but **without** `Access-Control-*` headers, so the browser refuses to expose it.

## Environment variables

All read from the **root** `.env` (`../../.env`), validated at startup; the
process exits with code 1 and lists every problem if anything is missing or
malformed. Set `DOTENV_CONFIG_PATH` to point at a different file (tests do).

| Variable | Purpose |
| --- | --- |
| `GATEWAY_PORT` | Listen port |
| `NODE_ENV`, `LOG_LEVEL` | Runtime mode; pino level (`trace`…`fatal`, `silent`) |
| `CORS_ALLOWED_ORIGINS` | Comma-separated bare origins. `*` is rejected. |
| `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | From dashboard.clerk.com → API Keys. Format is checked at boot — placeholders are rejected. |
| `CLERK_JWT_KEY` | Optional PEM public key for networkless verification |
| `CLERK_AUTHORIZED_PARTIES` | Optional comma-separated origins; when set, a token's `azp` claim must match one. Leave empty for server-minted tokens (Backend API, tests), which carry no `azp`. |
| `CATALOG_SERVICE_URL`, `CART_SERVICE_URL`, `ORDER_SERVICE_URL`, `PAYMENT_SERVICE_URL`, `INVENTORY_SERVICE_URL` | Upstream base URLs (one per route-table entry) |
| `GATEWAY_PROXY_TIMEOUT_MS` | Max wait for an upstream response before 503 |
| `GATEWAY_RATE_LIMIT_WINDOW_MS`, `GATEWAY_RATE_LIMIT_MAX` | Rate limit per client IP (`/health` exempt) |
| `GATEWAY_BODY_LIMIT` | Max request body (`1mb`, `512kb`…), enforced on `Content-Length` before proxying so bodies stream |
| `GATEWAY_SHUTDOWN_TIMEOUT_MS` | Grace period for in-flight requests on `SIGTERM`/`SIGINT` |
| `GATEWAY_TRUST_PROXY` | Express `trust proxy`: `false`, a hop count (`1` behind nginx) or `loopback`. `true` is rejected. |

## Code layout

```
src/
├── index.js                 entry: load .env → validate → listen → signals
├── app.js                   middleware order + route table wiring
├── server.js                listen + graceful shutdown
├── config/
│   ├── env.js               root .env loading + schema validation
│   └── routes.js            ROUTE TABLE
├── middleware/
│   ├── request-context.js   correlation id + identity-header stripping
│   ├── logging.js           pino-http (one JSON line per request)
│   ├── cors.js              origin allow-list, preflight handling
│   ├── rate-limit.js
│   ├── body-limit.js        Content-Length guard (no buffering)
│   ├── auth.js              Clerk verification → req.userId
│   └── error-handler.js     404 + uniform JSON errors
├── proxy/create-proxy.js    http-proxy-middleware factory (rewrite, headers, 503)
├── routes/health.js
└── lib/{logger,http-error}.js
test/
├── gateway.test.js          integration tests (node --test)
└── helpers/                 echo fixture standing in for a downstream service
```

## Testing the authenticated path

The automated tests exercise every rejection path with a format-valid dummy
key. The accepted path was verified in Step 3 with a real Clerk session token
minted through the Backend API (create user → create session →
`POST /v1/sessions/{id}/tokens`) and a full cart cycle through `/api/cart`.
To repeat it:

1. Real `pk_test_…` / `sk_test_…` in the root `.env`; `CLERK_AUTHORIZED_PARTIES` empty.
2. Mint a token: `curl -X POST -H "Authorization: Bearer $CLERK_SECRET_KEY" https://api.clerk.com/v1/sessions/<session_id>/tokens`
   (or copy one from a signed-in frontend).
3. `curl -H "Authorization: Bearer <jwt>" http://localhost:4000/api/cart` — the
   cart service logs `userId` equal to the token's `sub`.

A rejected token's reason (e.g. `token-expired`, `token-invalid-authorized-parties`)
is logged server-side on the 401 line; the client only sees "Invalid or expired token".

## Notes

- Node 22 prints `DeprecationWarning: The util._extend API is deprecated` on
  stderr at the first proxied request. It comes from the `http-proxy` package
  underneath `http-proxy-middleware` and is harmless.
- On Windows, `Ctrl+C` triggers the graceful shutdown path; `SIGTERM` is what
  Docker sends on Linux and is handled identically.
