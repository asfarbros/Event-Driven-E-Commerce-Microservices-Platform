/**
 * Clerk Authentication Middleware
 *
 * Intercepts incoming requests, extracts the Bearer token from the
 * Authorization header, and verifies it via Clerk's SDK.
 *
 * On success → injects `X-User-Id` header and calls next().
 * On failure → responds with 401 Unauthorized.
 */

const { createClerkClient } = require("@clerk/clerk-sdk-node");

const clerk = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
});

async function clerkAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Unauthorized",
        message: "Missing or malformed Authorization header.",
      });
    }

    const token = authHeader.split(" ")[1];

    // Verify the session token using Clerk's SDK
    const payload = await clerk.verifyToken(token);

    // Inject user ID into a custom header so downstream services can use it
    req.headers["x-user-id"] = payload.sub;

    return next();
  } catch (err) {
    console.error("[clerkAuth] Token verification failed:", err.message);
    return res.status(401).json({
      error: "Unauthorized",
      message: "Invalid or expired token.",
    });
  }
}

module.exports = clerkAuth;
