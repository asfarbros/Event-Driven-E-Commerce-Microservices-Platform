# API Gateway

**Status:** placeholder — implemented in Step 1.

## What it will do

The single public entry point for the OrderFlow frontend. Nothing else is exposed
to the browser.

- Node.js + Express.
- CORS, restricted to `CORS_ALLOWED_ORIGINS`.
- Verifies the Clerk session JWT on every protected route.
- Matches the incoming path to a downstream service and forwards the request with
  `http-proxy-middleware`.
- Injects an `X-User-Id` header (taken from the verified JWT) so downstream services
  never parse tokens themselves and never trust a client-supplied user id.

## Owns

No datastore. The gateway is stateless.

## Environment variables it reads

| Variable | Purpose |
| --- | --- |
| `GATEWAY_PORT` | Port to listen on |
| `CORS_ALLOWED_ORIGINS` | Comma-separated list of allowed browser origins |
| `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_JWT_KEY` | JWT verification |
| `CATALOG_SERVICE_URL`, `CART_SERVICE_URL`, `ORDER_SERVICE_URL`, `INVENTORY_SERVICE_URL`, `PAYMENT_SERVICE_URL` | Upstream targets for proxying |
