/**
 * Test configuration: the REAL MongoDB and Redis from the Step 0 infra
 * (credentials from the root .env) but an isolated database (cart_test_db)
 * and an isolated Redis key prefix (carttest:). Catalog is a fake fixture.
 */
import { loadDotenv, ROOT_ENV_PATH } from '../../src/config/env.js';

export const TEST_DB = 'cart_test_db';
export const TEST_PREFIX = 'carttest:';

export function testEnv(overrides = {}) {
  loadDotenv();
  const base = process.env.CART_MONGO_URI;
  if (!base) throw new Error(`CART_MONGO_URI not found — is ${ROOT_ENV_PATH} present?`);
  const uri = new URL(base);
  uri.pathname = `/${TEST_DB}`;

  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    CART_PORT: '4002',
    CART_MONGO_URI: uri.toString(),
    CART_DB_NAME: TEST_DB,
    CART_MONGO_TIMEOUT_MS: '3000',
    CART_MONGO_RETRY_INTERVAL_MS: '500',
    REDIS_HOST: process.env.REDIS_HOST,
    REDIS_PORT: process.env.REDIS_PORT,
    REDIS_PASSWORD: process.env.REDIS_PASSWORD,
    CART_REDIS_KEY_PREFIX: TEST_PREFIX,
    CART_REDIS_TTL_SECONDS: '60',
    CART_REDIS_COMMAND_TIMEOUT_MS: '500',
    CATALOG_SERVICE_URL: 'http://127.0.0.1:9', // overridden per suite
    CART_CATALOG_TIMEOUT_MS: '300',
    CART_BREAKER_ERROR_THRESHOLD_PERCENT: '50',
    CART_BREAKER_VOLUME_THRESHOLD: '3',
    CART_BREAKER_RESET_TIMEOUT_MS: '600',
    CART_BREAKER_ROLLING_WINDOW_MS: '5000',
    CART_MAX_QUANTITY_PER_ITEM: '10',
    CART_MAX_LINE_ITEMS: '3',
    CART_BODY_LIMIT: '16kb',
    CART_SHUTDOWN_TIMEOUT_MS: '2000',
    ...overrides,
  };
}
