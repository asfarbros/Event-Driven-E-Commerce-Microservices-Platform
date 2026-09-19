/**
 * Catalog Service – Entry Point
 *
 * Express server that serves the product catalog from MongoDB (catalog_db).
 *
 * On startup the service:
 *  1. Connects to MongoDB
 *  2. Seeds dummy products (if the collection is empty)
 *  3. Starts listening on CATALOG_PORT
 */

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../../.env") });

const express = require("express");
const cors = require("cors");

const connectMongo = require("./config/mongo");
const seedProducts = require("./seeds/seedProducts");
const productRoutes = require("./routes/productRoutes");

// ─── Configuration ───────────────────────────────────────────────────────────

const PORT = process.env.CATALOG_PORT || 3001;

// ─── Express App ─────────────────────────────────────────────────────────────

const app = express();

app.use(cors());
app.use(express.json());

// ─── Health Check ────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "catalog-service" });
});

// ─── Routes ──────────────────────────────────────────────────────────────────

app.use("/", productRoutes); // GET / → list products

// ─── 404 Fallback ────────────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// ─── Bootstrap ───────────────────────────────────────────────────────────────

async function start() {
  try {
    await connectMongo();
    await seedProducts();

    app.listen(PORT, () => {
      console.log(`🚀 Catalog Service running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("[startup] Fatal error:", err);
    process.exit(1);
  }
}

start();
