import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchOrderStatus, keys } from '@/api/queries';
import { config } from '@/config/env';
import { isTerminal } from '@/lib/status';
import { isRetryable } from '@/api/errors';

/**
 * Polls GET /api/orders/{id}/status with TanStack Query.
 *
 *   interval  = min(initialMs × factor^n, maxMs)   n = polls so far (backoff: fast first, then slower)
 *   stops     when the status is terminal (CONFIRMED / FAILED / CANCELLED)
 *             or after timeoutMs (→ `timedOut`, the page shows "taking longer than expected" + manual refresh)
 *   pauses    while the tab is hidden (refetchIntervalInBackground: false) and refetches on focus
 *   detail    whenever the status changes, the full order (with its history) is invalidated so the timeline updates
 *
 * All four numbers come from VITE_ORDER_POLL_* in the root .env.
 */
export function useOrderStatusPolling(orderId: string, { enabled = true } = {}) {
  const { initialMs, maxMs, backoffFactor, timeoutMs } = config.polling;
  const qc = useQueryClient();
  const polls = useRef(0);
  const startedAt = useRef(Date.now());
  const lastStatus = useRef<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);

  const query = useQuery({
    queryKey: keys.orderStatus(orderId),
    queryFn: ({ signal }) => fetchOrderStatus(orderId, signal),
    enabled,
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchIntervalInBackground: false,
    retry: (n, e) => isRetryable(e) && n < 3,
    refetchInterval: (q) => {
      const status = q.state.data?.status;
      if (isTerminal(status)) return false;
      if (Date.now() - startedAt.current > timeoutMs) { setTimedOut(true); return false; }
      const next = Math.min(initialMs * backoffFactor ** polls.current, maxMs);
      polls.current += 1;
      return next;
    },
  });

  useEffect(() => {
    const status = query.data?.status;
    if (!status || status === lastStatus.current) return;
    lastStatus.current = status;
    qc.invalidateQueries({ queryKey: keys.order(orderId) });
  }, [query.data?.status, query.data?.updatedAt, orderId, qc]);

  /** Manual refresh: resets the backoff and the timeout window, then fetches now. */
  const refresh = useCallback(() => {
    polls.current = 0; startedAt.current = Date.now(); setTimedOut(false);
    qc.invalidateQueries({ queryKey: keys.order(orderId) });
    return query.refetch();
  }, [orderId, qc, query]);

  return { status: query.data?.status, paymentStatus: query.data?.paymentStatus, updatedAt: query.data?.updatedAt, isPolling: enabled && !isTerminal(query.data?.status) && !timedOut,
    timedOut, refresh, error: query.error, isPending: query.isPending, polls: polls.current };
}
