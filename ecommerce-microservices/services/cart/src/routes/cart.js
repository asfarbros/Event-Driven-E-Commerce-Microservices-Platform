/**
 * Cart routes. Paths are as seen by THIS service — the gateway strips
 * `/api/cart`. Every route requires X-User-Id (injected by the gateway) and
 * the database; the cart is always the caller's own.
 *
 *   GET    /                    cart with live prices (degrades gracefully)
 *   POST   /items               add { productId, quantity } (merges quantities)
 *   PATCH  /items/:productId    set exact quantity
 *   DELETE /items/:productId    remove a line
 *   DELETE /                    clear the cart
 *   GET    /snapshot            INTERNAL: strict priced cart for checkout
 */
import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { requireUser } from '../middleware/request-context.js';
import { requireDatabase } from '../db/mongo.js';
import { buildSchemas } from '../validation/cart.js';

export function cartRouter(config, cartService) {
  const s = buildSchemas(config);
  const router = Router();

  router.use(requireUser());
  router.use(requireDatabase());

  const ctx = (req) => ({ requestId: req.id, log: req.log });

  router.get('/', async (req, res) => {
    const { cache, body } = await cartService.getCart(req.userId, ctx(req));
    req.cacheStatus = cache;
    req.pricingStatus = body.pricing.status;
    res.setHeader('X-Cache', cache.toUpperCase());
    res.json(body);
  });

  router.get('/snapshot', async (req, res) => {
    const body = await cartService.getSnapshot(req.userId, ctx(req));
    req.cacheStatus = 'bypass';
    res.setHeader('Cache-Control', 'no-store');
    res.json(body);
  });

  router.post('/items', validate({ body: s.addItemBody }), async (req, res) => {
    res.json(await cartService.addItem(req.userId, req.validated.body, ctx(req)));
  });

  router.patch('/items/:productId', validate({ params: s.productParams, body: s.setQuantityBody }), async (req, res) => {
    res.json(await cartService.setQuantity(req.userId, { ...req.validated.params, ...req.validated.body }, ctx(req)));
  });

  router.delete('/items/:productId', validate({ params: s.productParams }), async (req, res) => {
    res.json(await cartService.removeItem(req.userId, req.validated.params, ctx(req)));
  });

  router.delete('/', async (req, res) => {
    await cartService.clearCart(req.userId, ctx(req));
    res.status(204).end();
  });

  return router;
}
