# Cart Service

Holds what a user intends to buy. Two ideas define it:

1. **Cache-aside.** MongoDB (`cart_db`) is the **permanent source of truth**; Redis
   is a **disposable copy with a TTL**. Wipe Redis and nothing is lost.
2. **The cart does not store price.** A line is `{ productId, quantity }`. Prices
   are fetched live from the Catalog service on every read.

Stack: Node.js 20+ · Express 5 · Mongoose 9 · ioredis 6 · **opossum 10** (circuit
breaker) · zod 4 · helmet · pino. ESM; the same config/logging/error/shutdown
conventions as [`api-gateway`](../api-gateway/README.md) and
[`catalog`](../catalog/README.md).

Connects to `cart_db` and Redis only — never `catalog_db`, Postgres, Kafka or
RabbitMQ. The loader refuses to start if `CART_MONGO_URI` names another database.

## Run it

```bash
cd services/cart
npm install
npm start          # reads ../../.env, listens on CART_PORT (4002)
npm run dev
npm test           # 22 integration tests: real MongoDB (cart_test_db) + Redis (carttest:*), fake Catalog
npm start | npx pino-pretty
```

Needs MongoDB (required) and Redis (optional — see resilience). For priced
reads the Catalog service must be running on `CATALOG_SERVICE_URL`. Through
the gateway every path below is prefixed with `/api/cart` and requires a Clerk
session token.

## Identity

Every request must carry `X-User-Id`, injected by the API Gateway after JWT
verification (the gateway strips any client-supplied value). No header → `401`.
The cart key is derived from that header and **nothing else**: request bodies
are `.strict()` (a smuggled `userId` is a validation error), query params and
URL segments are never consulted. A user can only ever touch their own cart.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/` | The cart with **live prices** and totals. Degrades gracefully (see below). `X-Cache: HIT / MISS / BYPASS / UNAVAILABLE`. |
| `POST` | `/items` | `{ productId, quantity? (default 1) }` — adds; an existing product's quantity is increased (one line per product). Verifies the product with Catalog first: `404 product_not_found`, `400 product_unavailable` (inactive), `503 catalog_unavailable` (cannot verify). |
| `PATCH` | `/items/:productId` | `{ quantity }` — sets the exact quantity. `404 item_not_in_cart`. |
| `DELETE` | `/items/:productId` | Removes the line. `404 item_not_in_cart`. |
| `DELETE` | `/` | Clears the cart → `204`. |
| `GET` | `/snapshot` | **Internal, strict** — for checkout. See contract below. |
| `GET` | `/health` | Liveness (always 200): `status` = `ok` / `degraded` (Redis down or breaker not closed) / `unhealthy` (MongoDB down); `db`, `redis`, `catalogBreaker` blocks. |
| `GET` | `/ready` | Readiness: 200 iff MongoDB is connected. Redis is not required. |

Write endpoints return the **contents** (no prices):
`{ userId, items: [{ productId, quantity }], itemCount, totalQuantity, updatedAt }`.

### `GET /` response

```json
{
  "userId": "user_2abc…",
  "items": [
    { "productId": "6aae…bac7", "quantity": 2, "priceStatus": "ok", "name": "Ripple Portable Bluetooth Speaker",
      "sku": "ELC-SPK-BT-05", "unitPriceInPaise": 229900, "lineTotalInPaise": 459800, "currency": "INR" },
    { "productId": "6aae…9999", "quantity": 1, "priceStatus": "not_found" }
  ],
  "itemCount": 2, "totalQuantity": 3,
  "currency": "INR",
  "totalInPaise": null,
  "pricing": { "status": "partial", "pricedItems": 1, "unpricedItems": 1, "pricedAt": "2026-…", "reason": "some_items_unavailable" },
  "degraded": false,
  "updatedAt": "2026-…"
}
```

- `priceStatus` per line: `ok` · `not_found` (Catalog no longer has it) ·
  `inactive` (soft-deleted) · `unavailable` (Catalog could not be reached).
  Problem lines are **kept** so the UI can tell the user; they are never dropped.
- `pricing.status`: `complete` (every line priced) · `partial` (Catalog answered
  but some lines are not purchasable) · `unavailable` (Catalog unreachable /
  breaker open).
- `totalInPaise` is a number **only when `pricing.status === "complete"`**;
  otherwise `null`. A total is never computed from missing prices.
- `degraded: true` only when Catalog could not be reached (`pricing.reason` is
  `catalog_timeout` / `catalog_network` / `catalog_breaker_open` / `catalog_upstream_error`).

## Money

All amounts are **integer paise** (`…InPaise`), matching Catalog. Line totals
are `unitPriceInPaise × quantity` and the cart total is their integer sum. Every
priced response states `currency`; it is `null` only when no line could be
priced (or lines disagree, which the snapshot rejects).

## Cache-aside design

```
Redis  cart:<userId>  →  { "userId", "items": [{ "productId", "quantity" }], "updatedAt" }   TTL = CART_REDIS_TTL_SECONDS
Mongo  cart_db.carts  →  { userId (unique), items: [{ productId, quantity }], createdAt, updatedAt }
```

**Read** (`GET /`): Redis GET → HIT: use it · MISS: MongoDB `findOne`, then Redis
SET with TTL (repopulate) → then **one** Catalog price call for all product ids
→ totals computed fresh. Prices are never written to Redis.

**Write** (`POST/PATCH/DELETE`): MongoDB first (`findOneAndUpdate` upsert on
`userId`) → then Redis SET of the new contents (or DEL on clear). If the Redis
step fails it is logged and the request still succeeds.

**Snapshot**: always reads MongoDB (`X-Cache: BYPASS`).

**Redis outage handling** (why Redis is an optimisation, not a dependency):

- `enableOfflineQueue: false`, a command timeout and no per-request retries →
  a dead or stalled Redis fails instantly and the request falls through to
  MongoDB (`X-Cache: UNAVAILABLE`). The service keeps working; `/health`
  shows `redis.connected: false`, `/ready` stays 200.
- When Redis comes back after an outage, the whole `cart:*` namespace is
  invalidated (SCAN + UNLINK): writes made during the outage never reached the
  Redis copies, and Redis persists keys across restarts, so those copies would
  be stale. Cost: one MongoDB read per user on their next request.
- The only residual staleness window is a process crash between the MongoDB
  write and the Redis write; the TTL bounds it.

## Calling Catalog — circuit breaker

`POST ${CATALOG_SERVICE_URL}/products/prices` is called **directly** (not via
the gateway), with the inbound `X-Request-Id` forwarded, once per read.

The call is wrapped in an opossum breaker configured from `.env`:

| Setting | Env var | Default |
| --- | --- | --- |
| Per-call timeout | `CART_CATALOG_TIMEOUT_MS` | 2000 |
| Failure % that opens the breaker | `CART_BREAKER_ERROR_THRESHOLD_PERCENT` | 50 |
| Minimum calls in the window before evaluating | `CART_BREAKER_VOLUME_THRESHOLD` | 3 |
| Time open before a trial call | `CART_BREAKER_RESET_TIMEOUT_MS` | 10000 |
| Rolling statistics window | `CART_BREAKER_ROLLING_WINDOW_MS` | 10000 |

States, each logged as it changes (`transition: "closed → OPEN"` etc.):

- **closed** — calls go to Catalog; failures (network, timeout, 5xx) are counted.
  A 4xx from Catalog means *our* request was wrong and does not count.
- **open** — after ≥3 calls with ≥50 % failures: every call is rejected in
  well under a millisecond (`EOPENBREAKER`) with no network traffic. `GET /`
  still returns the cart, degraded; `POST /items` answers `503 catalog_unavailable`.
- **half-open** — after the reset timeout, one trial call passes. Success →
  closed; failure → open again.

`GET /health` exposes `catalogBreaker: { state, stats, config }`.

Observed during verification (Catalog replaced by a listener that never
answers, timeout 2000 ms): reads 1–3 took 2.4 s each and returned degraded;
the breaker opened at the third failure; reads 4–8 were rejected in 0.08–0.3 ms
(breaker) and returned degraded; 10.0 s after opening it went half-open, the
trial read succeeded and it closed.

## `/snapshot` — the checkout contract (Order Service depends on this)

`GET /snapshot` with `X-User-Id` (via the gateway: `GET /api/cart/snapshot`).
Reads MongoDB directly, prices every line live, and **fails rather than
degrades**:

| Status | `error` | When |
| --- | --- | --- |
| 200 | — | Every line priced |
| 409 | `cart_empty` | No items |
| 409 | `cart_has_unavailable_items` | A line is `not_found` / `inactive`; `details: [{ field: "items.<productId>", message: "<reason>" }]` |
| 409 | `mixed_currencies` | Lines priced in different currencies |
| 503 | `pricing_unavailable` | Catalog unreachable / breaker open / timeout |
| 401 / 503 | `unauthorized` / `database_unavailable` | No identity / MongoDB down |

Success body:

```json
{
  "userId": "user_2abc…",
  "items": [
    { "productId": "6aae…bac7", "sku": "ELC-SPK-BT-05", "name": "Ripple Portable Bluetooth Speaker",
      "quantity": 5, "unitPriceInPaise": 229900, "lineTotalInPaise": 1149500, "currency": "INR" }
  ],
  "itemCount": 1,
  "totalQuantity": 5,
  "currency": "INR",
  "totalInPaise": 1149500,
  "pricedAt": "2026-09-19T19:18:51.899Z",
  "snapshotAt": "2026-09-19T19:18:51.903Z"
}
```

Guarantees: every line has `unitPriceInPaise`, `lineTotalInPaise` and
`currency`; `totalInPaise` is the exact integer sum of the lines; `pricedAt` is
Catalog's `asOf`. Order should charge exactly `totalInPaise` in `currency` and
then `DELETE /` (via the same user identity) after the order is accepted.
Responses carry `Cache-Control: no-store`.

## Validation & limits

| Rule | Env var | Error |
| --- | --- | --- |
| `quantity` integer ≥ 1 | — | `400 validation_error` (`body.quantity`) |
| `quantity` ≤ max, also across merges | `CART_MAX_QUANTITY_PER_ITEM` | `400 validation_error` / `400 quantity_limit_exceeded` |
| distinct lines ≤ max | `CART_MAX_LINE_ITEMS` | `400 cart_full` |
| `productId` is a 24-hex id (checked before calling Catalog) | — | `400 validation_error` |
| product must exist and be active | — | `404 product_not_found` / `400 product_unavailable` |

Errors use the shared shape `{ error, message, requestId, details? }`.

## Resilience summary

| Dependency | Down at boot | Goes down later | Effect |
| --- | --- | --- | --- |
| MongoDB (required) | HTTP starts; retries logged; `/health` unhealthy, `/ready` 503 | driver reconnects | cart routes → `503 database_unavailable` |
| Redis (optional) | starts without cache | reconnects; namespace invalidated on return | full correctness, `X-Cache: UNAVAILABLE` |
| Catalog | — | breaker opens | `GET /` degraded; `POST /items` 503; `/snapshot` 503 |

Graceful shutdown on `SIGTERM`/`SIGINT`: stop accepting, drain in-flight
requests (grace `CART_SHUTDOWN_TIMEOUT_MS`), then close MongoDB and Redis.

## Environment variables

From the root `.env`, validated at boot (exit 1 listing every problem):
`CART_PORT`, `CART_MONGO_URI` (must name `CART_DB_NAME`), `CART_DB_NAME`,
`CART_MONGO_TIMEOUT_MS`, `CART_MONGO_RETRY_INTERVAL_MS`, `REDIS_HOST`,
`REDIS_PORT`, `REDIS_PASSWORD`, `CART_REDIS_KEY_PREFIX`, `CART_REDIS_TTL_SECONDS`,
`CART_REDIS_COMMAND_TIMEOUT_MS`, `CATALOG_SERVICE_URL`, `CART_CATALOG_TIMEOUT_MS`,
`CART_BREAKER_*` (4), `CART_MAX_QUANTITY_PER_ITEM`, `CART_MAX_LINE_ITEMS`,
`CART_BODY_LIMIT`, `CART_SHUTDOWN_TIMEOUT_MS`, `NODE_ENV`, `LOG_LEVEL`.

## Code layout

```
src/
├── index.js                 boot: .env → config → listen → Mongo (retry) + Redis (best effort)
├── app.js · server.js
├── config/env.js            schema + cart_db ownership guard
├── db/mongo.js              connect-with-retry, requireDatabase()
├── db/redis.js              cache API that never throws; reconnect invalidation
├── clients/catalog.js       price lookup + opossum breaker
├── models/cart.js           { userId, items[{productId, quantity}] } — no price
├── services/cart.js         cache-aside reads, Mongo-first writes, pricing, snapshot
├── validation/cart.js       zod (strict bodies)
├── routes/{cart,health}.js
├── middleware/{request-context (requireUser), logging, validate, error-handler}.js
└── lib/{logger,http-error}.js
test/                        integration tests + fake Catalog fixture
```
