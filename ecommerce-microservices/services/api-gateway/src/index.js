/**
 * API Gateway – Entry Point
 *
 * A lightweight Express gateway that:
 *  1. Proxies /api/catalog/** → catalog service   (public)
 *  2. Proxies /api/cart/**    → cart service      (auth required)
 *  3. Proxies /api/orders/**  → order service     (auth required)
 *  4. Uses Clerk for JWT-based authentication on protected routes.
 */

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../../.env") });

const express = require("express");
const cors = require("cors");
const { createProxyMiddleware } = require("http-proxy-middleware");
const clerkAuth = require("./middleware/clerkAuth");

// ─── Configuration ───────────────────────────────────────────────────────────

const PORT = process.env.GATEWAY_PORT || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN;
const CATALOG_SERVICE_URL = process.env.CATALOG_SERVICE_URL;
const CART_SERVICE_URL = process.env.CART_SERVICE_URL;
const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL;

for (const [name, value] of Object.entries({
  CATALOG_SERVICE_URL,
  CART_SERVICE_URL,
  ORDER_SERVICE_URL,
  CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
})) {
  if (!value) {
    console.error(`[config] ${name} is not defined in the root .env`);
    process.exit(1);
  }
}

// ─── Express App ─────────────────────────────────────────────────────────────

const app = express();

app.use(cors(CORS_ORIGIN ? { origin: CORS_ORIGIN.split(",") } : undefined));

// ─── Health Check ────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "api-gateway" });
});

// ─── Proxy: /api/catalog → Catalog Service (PUBLIC) ──────────────────────────

app.use(
  "/api/catalog",
  createProxyMiddleware({
    target: CATALOG_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { "^/api/catalog": "" },
    on: {
      proxyReq: (proxyReq, req) => {
        console.log(
          `[proxy] ${req.method} ${req.originalUrl} → ${CATALOG_SERVICE_URL}`
        );
      },
      error: (err, req, res) => {
        console.error("[proxy] Catalog proxy error:", err.message);
        res.status(502).json({ error: "Catalog service unavailable" });
      },
    },
  })
);

// ─── Proxy: /api/cart → Cart Service (PROTECTED – Clerk Auth) ────────────────
// clerkAuth overwrites x-user-id with the verified Clerk subject so a
// client-supplied x-user-id header can never be used to access another
// user's cart.

app.use(
  "/api/cart",
  clerkAuth,
  createProxyMiddleware({
    target: CART_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { "^/api/cart": "" },
    on: {
      proxyReq: (proxyReq, req) => {
        if (req.headers["x-user-id"]) {
          proxyReq.setHeader("X-User-Id", req.headers["x-user-id"]);
        }
        console.log(
          `[proxy] ${req.method} ${req.originalUrl} → ${CART_SERVICE_URL} (user: ${req.headers["x-user-id"] || "unknown"})`
        );
      },
      error: (err, req, res) => {
        console.error("[proxy] Cart proxy error:", err.message);
        res.status(502).json({ error: "Cart service unavailable" });
      },
    },
  })
);

// ─── Proxy: /api/orders → Order Service (PROTECTED – Clerk Auth) ─────────────

app.use(
  "/api/orders",
  clerkAuth,
  createProxyMiddleware({
    target: ORDER_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { "^/api/orders": "" },
    on: {
      proxyReq: (proxyReq, req) => {
        if (req.headers["x-user-id"]) {
          proxyReq.setHeader("X-User-Id", req.headers["x-user-id"]);
        }
        console.log(
          `[proxy] ${req.method} ${req.originalUrl} → ${ORDER_SERVICE_URL} (user: ${req.headers["x-user-id"] || "unknown"})`
        );
      },
      error: (err, req, res) => {
        console.error("[proxy] Order proxy error:", err.message);
        res.status(502).json({ error: "Order service unavailable" });
      },
    },
  })
);

// ─── 404 Fallback ────────────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// ─── Start Server ────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`🚀 API Gateway running on http://localhost:${PORT}`);
  console.log(`   /api/catalog  → ${CATALOG_SERVICE_URL}  (public)`);
  console.log(`   /api/cart     → ${CART_SERVICE_URL}  (auth required)`);
  console.log(`   /api/orders   → ${ORDER_SERVICE_URL}  (auth required)`);
});
