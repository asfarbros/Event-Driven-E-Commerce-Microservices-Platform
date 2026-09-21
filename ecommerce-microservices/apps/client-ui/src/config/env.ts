/**
 * Runtime configuration — every value comes from VITE_* variables in the ROOT
 * .env (vite.config.ts points envDir at the repo root). Validated once at
 * start-up: a missing or malformed value stops the app with a readable message
 * instead of rendering a broken store. Only public values live here — the
 * Razorpay KEY ID and the Clerk PUBLISHABLE key are public by design; no
 * secret is ever read into the bundle.
 */
export interface AppConfig {
  apiBaseUrl: string;            // the API Gateway — the ONLY origin the browser talks to
  clerkPublishableKey: string;
  razorpayKeyId: string;
  polling: {
    initialMs: number;           // first polls of an order's status
    maxMs: number;               // ceiling after backoff
    backoffFactor: number;       // multiplier per poll while not terminal
    timeoutMs: number;           // stop polling and show "taking longer than expected"
  };
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

type Raw = Record<string, string | undefined>;

function str(raw: Raw, key: string, problems: string[], validate?: (v: string) => string | null): string {
  const v = raw[key]?.trim();
  if (!v) { problems.push(`${key} is required but missing or empty`); return ''; }
  const problem = validate?.(v);
  if (problem) { problems.push(`${key} ${problem}`); return ''; }
  return v;
}

function int(raw: Raw, key: string, problems: string[], { min, max }: { min: number; max: number }): number {
  const v = raw[key]?.trim();
  if (!v) { problems.push(`${key} is required but missing or empty`); return 0; }
  if (!/^\d+$/.test(v)) { problems.push(`${key} must be a whole number (got "${v}")`); return 0; }
  const n = Number(v);
  if (n < min || n > max) { problems.push(`${key} must be between ${min} and ${max} (got ${n})`); return 0; }
  return n;
}

export function loadConfig(raw: Raw = import.meta.env as unknown as Raw): AppConfig {
  const problems: string[] = [];
  const apiBaseUrl = str(raw, 'VITE_API_BASE_URL', problems, (v) => {
    try { const u = new URL(v); return ['http:', 'https:'].includes(u.protocol) ? null : 'must be an http(s) URL'; }
    catch { return `must be an absolute URL (got "${v}")`; }
  }).replace(/\/+$/, '');
  const clerkPublishableKey = str(raw, 'VITE_CLERK_PUBLISHABLE_KEY', problems, (v) =>
    /^pk_(test|live)_/.test(v) ? null : 'must start with pk_test_ or pk_live_ (the PUBLISHABLE key, never the secret)');
  const razorpayKeyId = str(raw, 'VITE_RAZORPAY_KEY_ID', problems, (v) =>
    /^rzp_(test|live)_/.test(v) ? null : 'must be a Razorpay KEY ID (rzp_test_… / rzp_live_…), never the key secret');
  const polling = {
    initialMs: int(raw, 'VITE_ORDER_POLL_INITIAL_MS', problems, { min: 250, max: 60_000 }),
    maxMs: int(raw, 'VITE_ORDER_POLL_MAX_MS', problems, { min: 250, max: 300_000 }),
    backoffFactor: int(raw, 'VITE_ORDER_POLL_BACKOFF_FACTOR', problems, { min: 1, max: 10 }),
    timeoutMs: int(raw, 'VITE_ORDER_POLL_TIMEOUT_MS', problems, { min: 1_000, max: 3_600_000 }),
  };
  if (polling.initialMs && polling.maxMs && polling.initialMs > polling.maxMs) {
    problems.push('VITE_ORDER_POLL_INITIAL_MS must not exceed VITE_ORDER_POLL_MAX_MS');
  }
  if (problems.length) throw new ConfigError(problems);
  return Object.freeze({ apiBaseUrl, clerkPublishableKey, razorpayKeyId, polling: Object.freeze(polling) });
}

// Loaded once; main.tsx catches ConfigError and renders the failure page.
export const config: AppConfig = loadConfig();
