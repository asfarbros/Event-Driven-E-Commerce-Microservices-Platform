/**
 * Cart Routes
 *
 * All cart operations use the `x-user-id` header as the Redis key
 * to isolate each user's cart data.
 *
 * GET    /cart  →  Fetch the user's cart from Redis.
 * POST   /cart  →  Add / update an item in the user's cart.
 * DELETE /cart  →  Clear the user's entire cart.
 */

const express = require("express");
const { redisClient } = require("../config/redis");

const router = express.Router();

/**
 * Helper: Build the Redis key for a given user's cart.
 */
function cartKey(userId) {
  return `cart:${userId}`;
}

// ─── GET /cart ───────────────────────────────────────────────────────────────
// Returns the user's cart as a JSON array of { productId, quantity } items.
router.get("/", async (req, res) => {
  try {
    const userId = req.headers["x-user-id"];

    if (!userId) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Missing x-user-id header.",
      });
    }

    const cartData = await redisClient.get(cartKey(userId));
    const items = cartData ? JSON.parse(cartData) : [];

    return res.json({ userId, items });
  } catch (err) {
    console.error("[cart] Error fetching cart:", err.message);
    return res.status(500).json({ error: "Failed to fetch cart" });
  }
});

// ─── POST /cart ──────────────────────────────────────────────────────────────
// Body: { "productId": "<id>", "quantity": <number> }
// Adds the item to the cart or updates its quantity if it already exists.
router.post("/", async (req, res) => {
  try {
    const userId = req.headers["x-user-id"];

    if (!userId) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Missing x-user-id header.",
      });
    }

    const { productId, quantity } = req.body;

    if (!productId || quantity == null) {
      return res.status(400).json({
        error: "Bad Request",
        message: "productId and quantity are required.",
      });
    }

    // Fetch existing cart (or start with an empty one)
    const cartData = await redisClient.get(cartKey(userId));
    const items = cartData ? JSON.parse(cartData) : [];

    // Upsert: update quantity if item exists, otherwise push new entry
    const existingIndex = items.findIndex((i) => i.productId === productId);

    if (existingIndex !== -1) {
      items[existingIndex].quantity = quantity;
    } else {
      items.push({ productId, quantity });
    }

    await redisClient.set(cartKey(userId), JSON.stringify(items));

    return res.status(200).json({
      message: "Cart updated",
      userId,
      items,
    });
  } catch (err) {
    console.error("[cart] Error updating cart:", err.message);
    return res.status(500).json({ error: "Failed to update cart" });
  }
});

// ─── DELETE /cart ─────────────────────────────────────────────────────────────
// Removes the entire cart for the user.
router.delete("/", async (req, res) => {
  try {
    const userId = req.headers["x-user-id"];

    if (!userId) {
      return res.status(400).json({
        error: "Bad Request",
        message: "Missing x-user-id header.",
      });
    }

    await redisClient.del(cartKey(userId));

    return res.json({
      message: "Cart cleared",
      userId,
    });
  } catch (err) {
    console.error("[cart] Error clearing cart:", err.message);
    return res.status(500).json({ error: "Failed to clear cart" });
  }
});

module.exports = router;
