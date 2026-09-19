# Catalog Service

**Status:** placeholder — implemented in Step 2.

## What it will do

Product catalogue: categories, products, prices, images, and search/listing for
the storefront. Read-heavy, public for reads, admin-only for writes.

- Node.js + Express.
- MongoDB, database **`catalog_db`** (created automatically on first write).

## Owns

`catalog_db` in MongoDB — and only that. No other service reads or writes it.
Other services that need product data (e.g. Cart, Order) call this service's API;
they never open its collections.

## Environment variables it reads

| Variable | Purpose |
| --- | --- |
| `CATALOG_PORT` | Port to listen on |
| `CATALOG_MONGO_URI` | Connection string pointing at `catalog_db` |
| `LOG_LEVEL`, `NODE_ENV` | Runtime behaviour |
