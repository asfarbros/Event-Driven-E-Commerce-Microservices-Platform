/**
 * ROUTE TABLE — the single place that maps public URL prefixes to services.
 *
 * To plug in a new service later, add ONE entry here and ONE `*_SERVICE_URL`
 * variable to the root .env / .env.example. Nothing else in the gateway changes:
 * env validation, auth, proxying and logging all derive from this table.
 *
 * Fields
 *   name       Short service name used in logs and client-facing error messages
 *              (never the URL — internal hostnames must not leak to clients).
 *   prefix     Public path prefix. Matches `prefix` and `prefix/…` only, so
 *              `/api/cart` never matches `/api/cartography`.
 *   targetEnv  Name of the env var holding the service's base URL. Validated at
 *              startup: the gateway refuses to boot if it is missing/invalid.
 *   auth       true  → a valid Clerk session token is required (401 otherwise)
 *                      and X-User-Id is injected on the proxied request.
 *              false → public; forwarded with no identity header.
 *   rewrite    'strip-prefix' → remove `prefix` before forwarding
 *                               (/api/catalog/products → /products)
 *              'none'         → forward the path unchanged
 *              (path) => path → custom function for special cases
 *
 * Order matters only if two prefixes overlap (they must not — validated).
 */
export const routes = [
  // ---- Public: browsing the catalogue must work logged-out ----
  { name: 'catalog',   prefix: '/api/catalog',   targetEnv: 'CATALOG_SERVICE_URL',   auth: false, rewrite: 'strip-prefix' },

  // ---- Protected: valid Clerk JWT required ----
  { name: 'cart',      prefix: '/api/cart',      targetEnv: 'CART_SERVICE_URL',      auth: true,  rewrite: 'strip-prefix' },
  { name: 'orders',    prefix: '/api/orders',    targetEnv: 'ORDER_SERVICE_URL',     auth: true,  rewrite: 'strip-prefix' },
  { name: 'payments',  prefix: '/api/payments',  targetEnv: 'PAYMENT_SERVICE_URL',   auth: true,  rewrite: 'strip-prefix' },
  { name: 'inventory', prefix: '/api/inventory', targetEnv: 'INVENTORY_SERVICE_URL', auth: true,  rewrite: 'strip-prefix' },
];

/**
 * Sanity-check the table itself so a typo fails at boot, not on the first request.
 * Returns a list of human-readable problems (empty = OK).
 */
export function validateRoutes(table) {
  const problems = [];
  const seenPrefixes = new Set();
  const seenNames = new Set();

  for (const route of table) {
    const label = `route "${route.name ?? '?'}"`;
    if (!route.name) problems.push(`${label}: "name" is required`);
    if (!route.prefix || !route.prefix.startsWith('/') || route.prefix.endsWith('/') || route.prefix === '/') {
      problems.push(`${label}: "prefix" must start with "/" and not end with "/" (got "${route.prefix}")`);
    }
    if (!route.targetEnv) problems.push(`${label}: "targetEnv" is required`);
    if (typeof route.auth !== 'boolean') problems.push(`${label}: "auth" must be true or false`);
    if (!['strip-prefix', 'none'].includes(route.rewrite) && typeof route.rewrite !== 'function') {
      problems.push(`${label}: "rewrite" must be 'strip-prefix', 'none' or a function`);
    }
    if (seenPrefixes.has(route.prefix)) problems.push(`${label}: duplicate prefix "${route.prefix}"`);
    if (seenNames.has(route.name)) problems.push(`${label}: duplicate name`);
    seenPrefixes.add(route.prefix);
    seenNames.add(route.name);
  }

  // Overlapping prefixes (e.g. /api/orders and /api/orders/admin) would make
  // routing order-dependent; forbid them outright.
  for (const a of table) {
    for (const b of table) {
      if (a !== b && a.prefix && b.prefix && b.prefix.startsWith(a.prefix + '/')) {
        problems.push(`route "${b.name}" prefix "${b.prefix}" is nested under route "${a.name}" prefix "${a.prefix}"`);
      }
    }
  }
  return problems;
}
