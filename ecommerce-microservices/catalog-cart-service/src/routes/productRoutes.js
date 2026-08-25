/**
 * Product Routes
 *
 * GET /  →  Fetch all products from MongoDB.
 */

const express = require("express");
const Product = require("../models/Product");

const router = express.Router();

// GET / – List all products
router.get("/", async (_req, res) => {
  try {
    const products = await Product.find().sort({ createdAt: -1 });
    return res.json({
      count: products.length,
      products,
    });
  } catch (err) {
    console.error("[products] Error fetching products:", err.message);
    return res.status(500).json({ error: "Failed to fetch products" });
  }
});

module.exports = router;
