/**
 * Redis Client
 *
 * Creates and exports a connected Redis client using the REDIS_URL env var.
 */

const { createClient } = require("redis");

if (!process.env.REDIS_URL) {
  throw new Error("REDIS_URL is not defined in the root .env");
}

const redisClient = createClient({
  url: process.env.REDIS_URL,
});

redisClient.on("error", (err) => {
  console.error("[redis] Client error:", err.message);
});

redisClient.on("connect", () => {
  console.log("[redis] Connected to Redis");
});

async function connectRedis() {
  if (!redisClient.isOpen) {
    await redisClient.connect();
  }
}

module.exports = { redisClient, connectRedis };
