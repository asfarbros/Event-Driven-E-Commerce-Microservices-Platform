import type { HistoryEntry } from '@/api/types';
import type { OrderStatus } from '@/lib/status';
import { cn } from '@/lib/cn';

/**
 * The order's saga, as it happens. A vertical stepper built from the order's
 * status history (the server's audit trail, one row per transition):
 *
 *   Order placed → Stock reserved → Awaiting payment → Payment received → Confirmed
 *                                                    ↘ Not completed / Cancelled (with the reason)
 *
 * Each completed step carries its real timestamp; the current step pulses
 * while the order is live; a step pops in as it completes. Notes after the
 * terminal state (refund requested, stock restocked) render as quiet rows.
 */
type StepState = 'done' | 'current' | 'upcoming' | 'failed' | 'cancelled';
interface Step { key: string; title: string; description?: string; at?: string; state: StepState }

const time = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : undefined);
const date = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : undefined);

const HAPPY: Array<{ status: OrderStatus; title: string; description: string }> = [
  { status: 'PENDING', title: 'Order placed', description: 'Your items and prices were locked in.' },
  { status: 'RESERVED', title: 'Stock reserved', description: 'Your items are held for you.' },
  { status: 'AWAITING_PAYMENT', title: 'Awaiting payment', description: 'Complete the payment with Razorpay.' },
  { status: 'CONFIRMED', title: 'Payment received', description: 'Razorpay confirmed the payment.' },
];

export function buildSteps(status: OrderStatus, history: HistoryEntry[]): { steps: Step[]; notes: HistoryEntry[] } {
  const reached = (s: OrderStatus) => history.find((h) => h.to === s && h.from !== s);
  const terminalEntry = history.find((h) => (h.to === 'FAILED' || h.to === 'CANCELLED') && h.from !== h.to);
  const notes = history.filter((h) => h.from === h.to);   // "noted" rows: restock, refund processed, stale events

  const steps: Step[] = [];
  let currentPlaced = false;
  for (const h of HAPPY) {
    const entry = reached(h.status);
    if (entry) {
      steps.push({ key: h.status, title: h.title, description: entry.reason && h.status !== 'PENDING' ? undefined : h.description, at: entry.at, state: 'done' });
      continue;
    }
    if (terminalEntry) break;                       // the failure branch replaces the rest
    if (!currentPlaced) { steps.push({ key: h.status, title: h.title, description: h.description, state: 'current' }); currentPlaced = true; }
    else steps.push({ key: h.status, title: h.title, description: h.description, state: 'upcoming' });
  }
  if (status === 'CONFIRMED') {
    steps.push({ key: 'DONE', title: 'Confirmed', description: 'Your order is confirmed and being prepared.', at: reached('CONFIRMED')?.at, state: 'done' });
  } else if (terminalEntry) {
    const cancelled = terminalEntry.to === 'CANCELLED';
    steps.push({ key: terminalEntry.to, title: cancelled ? 'Cancelled' : 'Not completed', description: humanReason(terminalEntry.reason), at: terminalEntry.at, state: cancelled ? 'cancelled' : 'failed' });
  } else {
    steps.push({ key: 'DONE', title: 'Confirmed', description: 'We’ll confirm as soon as the payment is received.', state: 'upcoming' });
  }
  return { steps, notes };
}

/** Backend reasons are precise but technical; soften the common ones for customers. */
export function humanReason(reason: string | null | undefined): string | undefined {
  if (!reason) return undefined;
  const r = reason.toLowerCase();
  if (r.startsWith('payment failed')) return `The payment did not go through${reason.includes(':') ? ` — ${reason.split(':').slice(1).join(':').trim()}` : ''}. Nothing was charged.`;
  if (r.includes('hold expired')) return 'The payment wasn’t completed in time, so the items were released. Nothing was charged.';
  if (r.includes('abandoned')) return 'The checkout wasn’t completed, so the order was closed. Nothing was charged.';
  if (r.includes('cancelled by user after payment')) return 'You cancelled this order. A refund has been requested.';
  if (r.includes('cancelled by user')) return 'You cancelled this order. Nothing was charged.';
  if (r.includes('could not be confirmed')) return 'The stock could not be confirmed after payment. A refund has been requested.';
  if (r.includes('insufficient') || r.includes('short')) return 'Some items were out of stock. Nothing was charged.';
  return reason;
}

export function StatusTimeline({ status, history, live = false, className }:
  { status: OrderStatus; history: HistoryEntry[]; live?: boolean; className?: string }) {
  const { steps, notes } = buildSteps(status, history);
  return (
    <ol className={cn('relative flex flex-col', className)} aria-label="Order progress">
      {steps.map((s, i) => {
        const last = i === steps.length - 1;
        const done = s.state === 'done';
        const bad = s.state === 'failed' || s.state === 'cancelled';
        return (
          <li key={s.key} className="relative flex gap-4 pb-7 last:pb-0" aria-current={s.state === 'current' ? 'step' : undefined}>
            {!last && (
              <span aria-hidden="true" className={cn('absolute left-[13px] top-7 h-[calc(100%-1rem)] w-0.5 rounded-full', done ? 'bg-success' : 'bg-border')} />
            )}
            <span aria-hidden="true" className={cn('relative z-10 grid size-7 shrink-0 place-items-center rounded-full border-2',
              done && 'border-success bg-success text-accent-ink animate-step-pop',
              s.state === 'current' && cn('border-warning bg-surface', live && 'animate-pulse-ring'),
              s.state === 'upcoming' && 'border-border-strong bg-surface',
              s.state === 'failed' && 'border-danger bg-danger text-accent-ink animate-step-pop',
              s.state === 'cancelled' && 'border-neutral bg-neutral text-accent-ink animate-step-pop')}>
              {done && <svg viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round"><path d="m5 10.5 3.2 3L15 6.5" /></svg>}
              {s.state === 'current' && <span className="size-2.5 rounded-full bg-warning" />}
              {s.state === 'failed' && <svg viewBox="0 0 20 20" className="size-4" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round"><path d="m6.5 6.5 7 7M13.5 6.5l-7 7" /></svg>}
              {s.state === 'cancelled' && <svg viewBox="0 0 20 20" className="size-4" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round"><path d="M6 10h8" /></svg>}
            </span>
            <div className={cn('min-w-0 flex-1 pt-0.5', s.state === 'upcoming' && 'text-muted')}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
                <p className={cn('font-semibold', done && 'text-ink', s.state === 'current' && 'text-ink', s.state === 'failed' && 'text-danger', s.state === 'cancelled' && 'text-ink')}>{s.title}</p>
                {s.at && <time dateTime={s.at} className="text-xs text-muted tabular">{date(s.at)} · {time(s.at)}</time>}
              </div>
              {s.description && <p className={cn('mt-0.5 text-sm', bad ? 'text-ink-2' : 'text-muted')}>{s.description}</p>}
              {s.state === 'current' && live && <p className="mt-0.5 text-sm text-warning">In progress…</p>}
            </div>
          </li>
        );
      })}
      {notes.map((n, i) => (
        <li key={`note-${i}`} className="relative flex gap-4 pt-2">
          <span aria-hidden="true" className="relative z-10 mt-1.5 ml-2.5 size-2 shrink-0 rounded-full bg-border-strong" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4">
              <p className="text-sm text-muted">{humanNote(n.reason)}</p>
              <time dateTime={n.at} className="text-xs text-muted tabular">{time(n.at)}</time>
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function humanNote(reason: string | null): string {
  const r = (reason ?? '').toLowerCase();
  if (r.includes('restock')) return 'Items returned to stock';
  if (r.includes('refund processed')) return 'Refund processed by the payment provider';
  if (r.includes('refund')) return 'Refund in progress';
  if (r.includes('stale')) return 'A late update was ignored';
  return reason ?? 'Update';
}
