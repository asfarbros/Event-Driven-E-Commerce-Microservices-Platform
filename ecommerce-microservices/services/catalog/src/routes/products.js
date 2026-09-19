/**
 * Product routes. Paths are as seen by THIS service — the gateway has already
 * stripped `/api/catalog`, so `/api/catalog/products` arrives here as `/products`.
 *
 * Public reads (gateway requires no auth):
 *   GET  /products            list (paginated, filter, search, sort)
 *   GET  /products/:id        one active product
 *   POST /products/prices     bulk price lookup — the contract Cart and Order use
 *
 * Admin writes:
 *   POST   /products          create
 *   PUT    /products/:id      update
 *   DELETE /products/:id      soft delete
 *
 * TODO(auth-roles): the write endpoints are not yet restricted. The gateway
 * verifies identity and forwards X-User-Id, but role checks (admin vs
 * customer) are a later step. Until then, keep the catalog reachable only
 * through the gateway on a trusted network. Do NOT half-implement a check here.
 */
import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { requireDatabase } from '../db/mongo.js';
import { buildSchemas } from '../validation/products.js';
import * as products from '../services/products.js';

export function productsRouter(config) {
  const s = buildSchemas(config);
  const router = Router();

  router.use(requireDatabase());

  router.get('/products', validate({ query: s.listQuery }), async (req, res) => {
    res.json(await products.listProducts(req.validated.query));
  });

  // Declared before /products/:id so "prices" is never parsed as an id.
  router.post('/products/prices', validate({ body: s.pricesBody }), async (req, res) => {
    const { productIds } = req.validated.body;
    const result = await products.lookupPrices(productIds);
    req.log.info({ requested: productIds.length, found: result.prices.length, unavailable: result.unavailable.length }, 'price lookup');
    res.json(result);
  });

  router.get('/products/:id', validate({ params: s.idParams }), async (req, res) => {
    res.json(await products.getActiveProduct(req.validated.params.id));
  });

  router.post('/products', validate({ body: s.createBody }), async (req, res) => {
    const product = await products.createProduct(req.validated.body);
    req.log.info({ productId: product.id, sku: product.sku, actor: req.userId ?? null }, 'product created');
    res.status(201).location(`/products/${product.id}`).json(product);
  });

  router.put('/products/:id', validate({ params: s.idParams, body: s.updateBody }), async (req, res) => {
    const product = await products.updateProduct(req.validated.params.id, req.validated.body);
    req.log.info({ productId: product.id, fields: Object.keys(req.validated.body), actor: req.userId ?? null }, 'product updated');
    res.json(product);
  });

  router.delete('/products/:id', validate({ params: s.idParams }), async (req, res) => {
    const product = await products.deactivateProduct(req.validated.params.id);
    req.log.info({ productId: product.id, sku: product.sku, actor: req.userId ?? null }, 'product deactivated (soft delete)');
    res.json({ id: product.id, sku: product.sku, isActive: product.isActive, deletedAt: product.updatedAt });
  });

  return router;
}
