/**
 * Cart Service – Entry Point
 *
 * Express server that manages per-user shopping carts.
 *
 * Current state: Redis is the only store. The target design adds MongoDB
 * (cart_db) as the permanent source of truth with Redis as a cache-aside
 * layer — that persistence layer is added in a later step.
 *
 * On startup the service:
 *  1. Connects to Redis
 *  2. Starts listening on CART_PORT
 */

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../../.env") });

const express = require("express");
const cors = require("cors");

const { connectRedis } = require("./config/redis");
const cartRoutes = require("./routes/cartRoutes");

// ─── Configuration ───────────────────────────────────────────────────────────

const PORT = process.env.CART_PORT || 3002;

// ─── Express App ─────────────────────────────────────────────────────────────

const app = express();

app.use(cors());
app.use(express.json());

// ─── Health Check ────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "cart-service" });
});

// ─── Routes ──────────────────────────────────────────────────────────────────

app.use("/", cartRoutes); // GET|POST|DELETE / → cart operations

// ─── 404 Fallback ────────────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// ─── Bootstrap ───────────────────────────────────────────────────────────────

async function start() {
  try {
    await connectRedis();

    app.listen(PORT, () => {
      console.log(`🚀 Cart Service running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("[startup] Fatal error:", err);
    process.exit(1);
  }
}

start();
