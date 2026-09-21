/**
 * The single HTTP client. Every request in the app goes through `api()`:
 *
 *   - ONE base URL (the API Gateway, VITE_API_BASE_URL). The browser never
 *     talks to Catalog, Cart, Order, Inventory or Payment directly.
 *   - Auth: the Clerk session token is attached as `Authorization: Bearer …`
 *     by a token provider registered once by <AuthBridge> (no per-component
 *     plumbing). The Gateway derives identity from it; NO user id is ever sent.
 *   - Correlation: every call sends an `X-Request-Id` (UUID). The Gateway
 *     echoes it, and it is the trace id through every service — errors carry
 *     it back as `requestId` for the "Reference:" line.
 *   - Errors: any non-2xx becomes an ApiError from the backend's
 *     `{ error, message, requestId, details? }`; network failures become
 *     ApiError(0, 'network_error'); an aborted timeout ApiError(0, 'timeout').
 *   - Token expiry: on 401 the token is refreshed once (skipCache) and the
 *     request retried; a second 401 raises `unauthorized` and notifies the app
 *     (it redirects to sign-in and returns the user afterwards).
 *   - Transient retries (503/network) are TanStack Query's job (see queries.ts),
 *     not this layer's, so the policy lives in one place per query/mutation.
 */
import { config } from '@/config/env';
import { ApiError } from './errors';

type TokenProvider = (opts?: { skipCache?: boolean }) => Promise<string | null>;
let tokenProvider: TokenProvider | null = null;
export function setTokenProvider(p: TokenProvider | null) { tokenProvider = p; }

/** Fired when a request is rejected even after a token refresh — the app routes to sign-in. */
export const UNAUTHORIZED_EVENT = 'orderflow:unauthorized';

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
  auth?: boolean;          // default true; catalog reads pass false so browsing works signed out
  timeoutMs?: number;      // default 15 s
  signal?: AbortSignal;
}

export interface ApiResponse<T> { data: T; requestId: string | null; status: number }

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<ApiResponse<T>> {
  const { method = 'GET', body, headers = {}, auth = true, timeoutMs = 15_000, signal } = opts;
  const requestId = crypto.randomUUID();
  const url = `${config.apiBaseUrl}${path.startsWith('/') ? path : `/${path}`}`;

  const attempt = async (skipCache: boolean): Promise<Response> => {
    const h: Record<string, string> = { Accept: 'application/json', 'X-Request-Id': requestId, ...headers };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (auth && tokenProvider) {
      const token = await tokenProvider({ skipCache });
      if (token) h.Authorization = `Bearer ${token}`;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs);
    signal?.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    try {
      return await fetch(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal, credentials: 'omit' });
    } catch (err) {
      const e = err as { name?: string };
      if (e?.name === 'TimeoutError' || (controller.signal.aborted && controller.signal.reason?.name === 'TimeoutError')) {
        throw new ApiError(0, 'timeout', 'The request timed out', requestId);
      }
      if (e?.name === 'AbortError') throw err;
      throw new ApiError(0, 'network_error', 'The store could not be reached', requestId);
    } finally {
      window.clearTimeout(timer);
    }
  };

  let res = await attempt(false);
  if (res.status === 401 && auth && tokenProvider) {
    // The token may simply have expired between Clerk's cache and the request: refresh once and retry.
    res = await attempt(true);
    if (res.status === 401) window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
  }

  const echoedId = res.headers.get('x-request-id') ?? requestId;
  const text = await res.text();
  let json: unknown = null;
  if (text) { try { json = JSON.parse(text); } catch { json = null; } }

  if (!res.ok) {
    const b = (json ?? {}) as { error?: string; message?: string; requestId?: string; details?: unknown };
    const code = b.error ?? (res.status === 401 ? 'unauthorized' : res.status === 404 ? 'not_found' : res.status === 429 ? 'rate_limited' : `http_${res.status}`);
    throw new ApiError(res.status, code, b.message ?? `Request failed (${res.status})`, b.requestId ?? echoedId, b.details);
  }
  return { data: json as T, requestId: echoedId, status: res.status };
}
