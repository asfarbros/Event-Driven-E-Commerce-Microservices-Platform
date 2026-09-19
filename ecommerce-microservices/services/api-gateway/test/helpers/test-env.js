/**
 * Builds a complete, valid environment map for tests. Callers override the
 * handful of values a test cares about (usually the service URLs).
 *
 * The Clerk publishable key is a FORMAT-valid dummy (base64 host ending in "$")
 * so the real @clerk/backend code path runs; it is not a real instance, so
 * only the rejection paths (no token / malformed / forged) can be exercised.
 */
const DUMMY_PK = `pk_test_${Buffer.from('orderflow-test.clerk.accounts.dev$').toString('base64')}`;

// A closed port: connections are refused immediately (simulates "service not built yet").
export const UNREACHABLE = 'http://127.0.0.1:9';

export function testEnv(overrides = {}) {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    GATEWAY_PORT: '4000', // validated only; tests listen on an ephemeral port
    CORS_ALLOWED_ORIGINS: 'http://localhost:5173,https://shop.example.com',
    CLERK_PUBLISHABLE_KEY: DUMMY_PK,
    CLERK_SECRET_KEY: 'sk_test_dummyDummyDummyDummyDummyDummy',
    CLERK_JWT_KEY: '',
    GATEWAY_PROXY_TIMEOUT_MS: '1000',
    GATEWAY_RATE_LIMIT_WINDOW_MS: '60000',
    GATEWAY_RATE_LIMIT_MAX: '1000',
    GATEWAY_BODY_LIMIT: '64kb',
    GATEWAY_SHUTDOWN_TIMEOUT_MS: '2000',
    GATEWAY_TRUST_PROXY: 'false',
    CATALOG_SERVICE_URL: UNREACHABLE,
    CART_SERVICE_URL: UNREACHABLE,
    ORDER_SERVICE_URL: UNREACHABLE,
    INVENTORY_SERVICE_URL: UNREACHABLE,
    PAYMENT_SERVICE_URL: UNREACHABLE,
    ...overrides,
  };
}
