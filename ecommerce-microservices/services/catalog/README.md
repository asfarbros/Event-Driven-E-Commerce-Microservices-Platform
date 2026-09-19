# Catalog Service

The single owner of product data and — critically — of **price**. No other
service stores or decides a product's authoritative price: Cart calls this
service to display prices, and Order calls it at checkout to compute the amount
actually charged. It is read-heavy (browsing) with rare administrative writes.

Stack: Node.js 20+ · Express 5 · Mongoose 9 (MongoDB `catalog_db`) · **zod 4**
for validation · helmet · pino. ESM, same conventions as
[`services/api-gateway`](../api-gateway/README.md): root `.env`, boot-time
config validation, `{ error, message, requestId }` errors, graceful shutdown.

It connects to **one** database (`catalog_db`) and nothing else — no Postgres,
Kafka or RabbitMQ (events come in a much later step). The loader refuses to
start if `CATALOG_MONGO_URI` names any other database.

## Run it

```bash
cd services/catalog
npm install
npm start                # reads ../../.env, listens on CATALOG_PORT (4001)
npm run dev              # restart on file change
npm run seed             # insert the 14 demo products (idempotent — safe to re-run)
npm run seed:update      # also overwrite existing seed SKUs with the seed values
npm test                 # 31 integration tests (needs the Step 0 MongoDB; uses catalog_test_db)
npm start | npx pino-pretty
```

The HTTP server starts even if MongoDB is unreachable; it logs a clear
"unreachable — will retry" line every `CATALOG_MONGO_RETRY_INTERVAL_MS`,
`/health` reports `db.state`, and data routes answer `503 database_unavailable`
until the connection is up. When Mongo drops later, the driver reconnects on
its own and `/health` follows.

Through the gateway the paths below are prefixed with `/api/catalog`
(`GET http://localhost:4000/api/catalog/products`); the gateway strips the
prefix before proxying.

## Money rule

**`priceInPaise` is an integer in the smallest unit of `currency`.**
₹1,299.00 is stored and returned as `129900` with `"currency": "INR"`. Never a
float, never a decimal string. Floats cannot represent 0.1 exactly, so cart
totals and percentage discounts computed in floating point drift by a paisa and
surface as reconciliation bugs at checkout; integers add exactly. Every response
carries both fields so the unit is never ambiguous. The validator rejects
negative and non-integer prices (`400`), and the Mongoose schema rejects them
again as a second line of defence.

## Product model

| Field | Type | Notes |
| --- | --- | --- |
| `id` | ObjectId (as `id` in JSON) | |
| `name` | string 1–200 | text-indexed (weight 10) |
| `description` | string 1–5000 | text-indexed (weight 2); omitted from listings |
| `priceInPaise` | **integer ≥ 0** | see money rule |
| `currency` | `AAA` ISO 4217 | defaults to `CATALOG_DEFAULT_CURRENCY` on create |
| `category` | slug `^[a-z0-9]+(-[a-z0-9]+)*$` | e.g. `home-kitchen` |
| `imageUrl` | http(s) URL or null | |
| `sku` | `^[A-Z0-9][A-Z0-9-]{1,47}$` | **unique**, normalised to upper case |
| `isActive` | boolean | soft-delete flag; default `true` |
| `createdAt`, `updatedAt` | timestamps | |

### Indexes (all in [`src/models/product.js`](src/models/product.js))

| Index | Serves |
| --- | --- |
| `{ sku: 1 }` **unique** | SKU uniqueness (E11000 → `409`); seed upserts and future imports by SKU |
| `{ isActive: 1, category: 1, createdAt: -1 }` | The default listing: always filtered on `isActive`, optionally on `category`, sorted newest-first. Equality fields precede the sort field (ESR rule) so pages come straight off the index with no in-memory sort. Used via its `isActive` prefix when no category is given. |
| `{ isActive: 1, category: 1, priceInPaise: 1 }` | Same prefix, `sort=price_asc` / `price_desc` (one ascending index serves both directions). |
| `{ name: "text", description: "text" }` weights 10:2 | `?q=` full-text search ranked by `textScore`; a name hit outranks a description mention. MongoDB allows one text index per collection. |
| `_id` (default) | `GET /products/:id` and the bulk price lookup (`$in`). |

Soft delete (`isActive: false`) removes a product from every public read and
from price lookups, but the document — and the price past orders were charged —
stays in the collection.

## Endpoints

Public reads (the gateway requires no token for `/api/catalog/*`):

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/products` | List. Query: `page` (≥1, default 1), `limit` (default `CATALOG_PAGE_LIMIT_DEFAULT`, **capped** at `CATALOG_PAGE_LIMIT_MAX`), `category`, `q` (text search, ≤100 chars), `sort` = `newest` (default) · `price_asc` · `price_desc` · `name_asc` · `relevance` (default when `q` is set), `includeInactive=true` (admin-oriented). Returns `{ items, pagination: { page, limit, total, totalPages, hasNext, hasPrev }, sort, filters }`. Listings omit `description`. |
| `GET` | `/products/:id` | One **active** product. `404 product_not_found` if missing or soft-deleted; `400` if the id is malformed. |
| `POST` | `/products/prices` | **Bulk price lookup** — see contract below. |

Admin writes:

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/products` | Create → `201` + `Location`. Body is strict: unknown fields (e.g. `price`) are rejected. Duplicate `sku` → `409 duplicate_sku`. |
| `PUT` | `/products/:id` | Partial update (≥1 field; `{}` is a `400`). |
| `DELETE` | `/products/:id` | Soft delete → `{ id, sku, isActive: false, deletedAt }`; already-inactive → `404`. |

> **TODO (later step): role-based restriction of the write endpoints.** The
> gateway verifies identity and forwards `X-User-Id`, but nothing distinguishes
> an admin from a customer yet. Until roles exist, the catalog must only be
> reachable through the gateway on a trusted network. This is deliberately not
> half-implemented here.

Health:

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Liveness — always `200` with `status: ok | degraded` and `db: { state, database, host }`. |
| `GET` | `/ready` | Readiness — `200` only while MongoDB is connected, else `503`. |

## Bulk price lookup — the contract Cart and Order depend on

`POST /products/prices` (`/api/catalog/products/prices` via the gateway)

Request:

```json
{ "productIds": ["6aaed83ee6d0a57903f7bad0", "6aaed83ee6d0a57903f7baca", "000000000000000000000000"] }
```

- 1 … `CATALOG_PRICE_LOOKUP_MAX_IDS` (200) ids, each a 24-hex ObjectId.
  Duplicates are allowed and collapsed.
- Malformed request → `400 validation_error` with `details[].field` such as
  `body.productIds.2`. Nothing else in the request is looked at.

Response — always `200` when the request is well-formed, even if some ids are
unavailable; consumers **must** read `unavailable`:

```json
{
  "prices": [
    { "productId": "6aaed83ee6d0a57903f7bad0", "sku": "SP-BALL-FB-5", "name": "Striker Match Football, Size 5", "priceInPaise": 144900, "currency": "INR" },
    { "productId": "6aaed83ee6d0a57903f7baca", "sku": "BK-KID-SKY-01", "name": "Where the Kites Go", "priceInPaise": 29900, "currency": "INR" }
  ],
  "unavailable": [
    { "productId": "000000000000000000000000", "reason": "not_found" }
  ],
  "asOf": "2026-09-19T18:46:40.100Z"
}
```

Guarantees:

- Every distinct requested id appears **exactly once**, in either `prices` or
  `unavailable` — nothing is silently omitted.
- `reason` is `not_found` (no such product) or `inactive` (soft-deleted). An
  inactive product's price is **not** returned; it must not be purchasable.
- `priceInPaise` is an integer in the smallest unit of `currency`.
- One database query per call (`{ _id: { $in } }` with a narrow projection),
  regardless of how many ids are sent — verified by a test that counts driver
  operations.
- `asOf` is the server time of the lookup. Order should call this at checkout
  and charge these values; Cart should call it when rendering, never cache a
  price as authoritative.

## Errors

Same shape as the gateway; `details` is added for validation errors.

| Status | `error` | When |
| --- | --- | --- |
| 400 | `validation_error` | Bad query/body/params — `details: [{ field, message }]` |
| 400 | `invalid_json` | Body is not JSON |
| 404 | `product_not_found` / `not_found` | Missing or inactive product / unknown route |
| 409 | `duplicate_sku` | SKU already exists |
| 413 | `payload_too_large` | Body over `CATALOG_BODY_LIMIT` |
| 503 | `database_unavailable` | MongoDB not connected / network error (never the Mongo message) |
| 500 | `internal_error` | Unexpected; details only in the log |

## Headers

| Header | Direction | Meaning |
| --- | --- | --- |
| `X-Request-Id` | in / out | Correlation id. Reused if well-formed (the gateway always sends one), otherwise minted. On every log line and echoed back. |
| `X-User-Id` | in | Set by the gateway on authenticated routes; absent on public reads. Logged as `userId`, recorded as `actor` on writes. **Not** used for authorisation (see TODO). |

## Environment variables

All from the root `.env`, validated at boot (exit 1 listing every problem).

| Variable | Purpose |
| --- | --- |
| `CATALOG_PORT` | Listen port |
| `CATALOG_MONGO_URI` | Connection string; must name `CATALOG_DB_NAME` |
| `CATALOG_DB_NAME` | `catalog_db` — the only database this service may touch |
| `CATALOG_DEFAULT_CURRENCY` | Currency for products created without one |
| `CATALOG_PAGE_LIMIT_DEFAULT`, `CATALOG_PAGE_LIMIT_MAX` | Pagination default and hard cap |
| `CATALOG_PRICE_LOOKUP_MAX_IDS` | Max ids per price lookup |
| `CATALOG_BODY_LIMIT` | Max JSON body |
| `CATALOG_SHUTDOWN_TIMEOUT_MS` | Grace period on SIGTERM/SIGINT |
| `CATALOG_MONGO_TIMEOUT_MS`, `CATALOG_MONGO_RETRY_INTERVAL_MS` | Connection attempt timeout and retry pause |
| `NODE_ENV`, `LOG_LEVEL` | Runtime mode; pino level |

## Code layout

```
src/
├── index.js                 boot: .env → config → listen → connect (retry) → signals
├── app.js                   middleware order + routers
├── server.js                listen + graceful shutdown
├── config/env.js            root .env loading + schema + ownership guard
├── db/mongo.js              connect-with-retry, state, requireDatabase() guard
├── models/product.js        schema, MONEY RULE, indexes, public JSON shape
├── validation/products.js   zod schemas (query / params / bodies)
├── services/products.js     every Mongo query
├── routes/{products,health}.js
├── middleware/{request-context,logging,validate,error-handler}.js
└── lib/{logger,http-error}.js
scripts/seed.js              idempotent demo data (npm run seed)
test/                        integration tests against catalog_test_db
```
