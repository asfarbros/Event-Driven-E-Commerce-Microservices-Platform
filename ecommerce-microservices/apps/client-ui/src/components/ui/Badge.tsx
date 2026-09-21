import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import { STATUS_META, type OrderStatus } from '@/lib/status';

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
const tones: Record<Tone, string> = {
  neutral: 'bg-neutral-soft text-neutral',
  accent: 'bg-accent-soft text-accent',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
};

export function Badge({ tone = 'neutral', className, ...rest }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return <span className={cn('inline-flex items-center rounded-sm px-2 py-0.5 text-xs font-semibold', tones[tone], className)} {...rest} />;
}

/** Order status → semantic pill. Green confirmed, amber in progress, red failed, grey cancelled. */
export function StatusPill({ status, className, live = false }: { status: OrderStatus | string; className?: string; live?: boolean }) {
  const meta = STATUS_META[status as OrderStatus] ?? { label: status, tone: 'neutral' as Tone };
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold', tones[meta.tone], className)}>
      <span aria-hidden="true" className={cn('size-1.5 rounded-full bg-current', live && 'animate-pulse-ring')} />
      {meta.label}
    </span>
  );
}
