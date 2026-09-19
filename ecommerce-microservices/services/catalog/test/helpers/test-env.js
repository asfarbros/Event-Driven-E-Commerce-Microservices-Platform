/**
 * Test configuration. Uses the REAL MongoDB from the Step 0 infrastructure
 * (credentials/port from the root .env) but a dedicated database,
 * `catalog_test_db`, so tests never touch demo data in catalog_db.
 * Requires `docker compose … up -d` to be running.
 */
import { loadDotenv, ROOT_ENV_PATH } from '../../src/config/env.js';

export const TEST_DB = 'catalog_test_db';

export function testEnv(overrides = {}) {
  loadDotenv();
  const base = process.env.CATALOG_MONGO_URI;
  if (!base) throw new Error(`CATALOG_MONGO_URI not found — is ${ROOT_ENV_PATH} present?`);
  const uri = new URL(base);
  uri.pathname = `/${TEST_DB}`;

  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    CATALOG_PORT: '4001',
    CATALOG_MONGO_URI: uri.toString(),
    CATALOG_DB_NAME: TEST_DB,
    CATALOG_DEFAULT_CURRENCY: 'INR',
    CATALOG_PAGE_LIMIT_DEFAULT: '5',
    CATALOG_PAGE_LIMIT_MAX: '10',
    CATALOG_PRICE_LOOKUP_MAX_IDS: '50',
    CATALOG_BODY_LIMIT: '64kb',
    CATALOG_SHUTDOWN_TIMEOUT_MS: '2000',
    CATALOG_MONGO_TIMEOUT_MS: '3000',
    CATALOG_MONGO_RETRY_INTERVAL_MS: '500',
    ...overrides,
  };
}
