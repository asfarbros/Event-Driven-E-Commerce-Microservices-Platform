/**
 * API Gateway – Entry Point
 *
 * A lightweight Express gateway that:
 *  1. Proxies /api/catalog/** → catalog-cart-service:3001  (public)
 *  2. Proxies /api/orders/**  → order-service:8080         (auth required)
 *  3. Uses Clerk for JWT-based authentication on protected routes.
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { createProxyMiddleware } = require("http-proxy-middleware");
const clerkAuth = require("./middleware/clerkAuth");

// ─── Configuration ───────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const CATALOG_SERVICE_URL =
  process.env.CATALOG_SERVICE_URL || "http://catalog-cart-service:3001";
const ORDER_SERVICE_URL =
  process.env.ORDER_SERVICE_URL || "http://order-service:8080";

// ─── Express App ─────────────────────────────────────────────────────────────

const app = express();

app.use(cors());

// ─── Health Check ────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "api-gateway" });
});

// ─── Proxy: /api/catalog → Catalog + Cart Service (PUBLIC) ───────────────────

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

// ─── Proxy: /api/orders → Order Service (PROTECTED – Clerk Auth) ─────────────

app.use(
  "/api/orders",
  clerkAuth, // ← authentication middleware applied ONLY here
  createProxyMiddleware({
    target: ORDER_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { "^/api/orders": "" },
    on: {
      proxyReq: (proxyReq, req) => {
        // Forward the X-User-Id header to the downstream service
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
  console.log(`   /api/orders   → ${ORDER_SERVICE_URL}  (auth required)`);
});
