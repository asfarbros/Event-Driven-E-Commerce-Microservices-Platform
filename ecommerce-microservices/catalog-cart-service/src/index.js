/**
 * Catalog & Cart Service – Entry Point
 *
 * Express server on port 3001 that provides:
 *  - Product catalog (MongoDB)
 *  - Shopping cart (Redis)
 *
 * On startup the service:
 *  1. Connects to MongoDB
 *  2. Seeds dummy products (if DB is empty)
 *  3. Connects to Redis
 *  4. Starts listening on PORT
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");

const connectMongo = require("./config/mongo");
const { connectRedis } = require("./config/redis");
const seedProducts = require("./seeds/seedProducts");

const productRoutes = require("./routes/productRoutes");
const cartRoutes = require("./routes/cartRoutes");

// ─── Configuration ───────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;

// ─── Express App ─────────────────────────────────────────────────────────────

const app = express();

app.use(cors());
app.use(express.json());

// ─── Health Check ────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "catalog-cart-service" });
});

// ─── Routes ──────────────────────────────────────────────────────────────────

app.use("/", productRoutes); // GET /           → list products
app.use("/cart", cartRoutes); // GET|POST|DELETE /cart → cart operations

// ─── 404 Fallback ────────────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// ─── Bootstrap ───────────────────────────────────────────────────────────────

async function start() {
  try {
    // 1. Connect to MongoDB
    await connectMongo();

    // 2. Seed dummy products if the collection is empty
    await seedProducts();

    // 3. Connect to Redis
    await connectRedis();

    // 4. Start Express server
    app.listen(PORT, () => {
      console.log(
        `🚀 Catalog-Cart Service running on http://localhost:${PORT}`
      );
    });
  } catch (err) {
    console.error("[startup] Fatal error:", err);
    process.exit(1);
  }
}

start();
