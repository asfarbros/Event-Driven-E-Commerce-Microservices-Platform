# Cart Service

**Status:** placeholder — implemented in Step 3.

## What it will do

Per-user shopping cart: add / update / remove line items, fetch the cart, clear it
after checkout. Identified by the `X-User-Id` header injected by the API Gateway.

- Node.js + Express.
- **Redis** as a fast cache for the hot cart.
- **MongoDB**, database **`cart_db`**, as the permanent source of truth.
- Cache-aside pattern: read from Redis → on miss, load from Mongo and populate
  Redis; writes go to Mongo first, then refresh/invalidate Redis.

## Owns

`cart_db` in MongoDB (created automatically on first write) and its own key
namespace in Redis. Nothing else touches either.

## Environment variables it reads

| Variable | Purpose |
| --- | --- |
| `CART_PORT` | Port to listen on |
| `CART_MONGO_URI` | Connection string pointing at `cart_db` |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` | Redis cache |
| `CATALOG_SERVICE_URL` | To validate products / fetch prices via the Catalog API |
| `LOG_LEVEL`, `NODE_ENV` | Runtime behaviour |
