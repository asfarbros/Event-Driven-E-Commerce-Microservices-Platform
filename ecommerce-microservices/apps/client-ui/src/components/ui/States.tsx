import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Button } from './Button';
import { describeError, isRetryable, type ApiError } from '@/api/errors';

/** Empty state: a short title, one line of plain copy, one action. */
export function EmptyState({ title, description, action, className }:
  { title: string; description?: string; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center gap-3 rounded-lg border border-dashed border-border-strong px-6 py-12 text-center', className)}>
      <h2 className="text-2xl">{title}</h2>
      {description && <p className="max-w-prose text-muted">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/**
 * Error state: calm, human copy from the error layer, a retry when the
 * failure is transient, and the request id as a discreet reference line —
 * it is the trace id, so support (and demos) can find the exact request.
 */
export function ErrorState({ error, onRetry, title, className, compact = false }:
  { error: unknown; onRetry?: () => void; title?: string; className?: string; compact?: boolean }) {
  const d = describeError(error);
  const retryable = onRetry && isRetryable(error);
  return (
    <div role="alert" className={cn('flex flex-col items-start gap-3 rounded-lg border border-border bg-surface', compact ? 'p-4' : 'p-6', className)}>
      <div>
        <p className={cn('font-semibold text-ink', compact ? 'text-base' : 'text-lg')}>{title ?? d.title}</p>
        <p className="mt-1 text-muted">{d.message}</p>
      </div>
      {retryable && <Button variant="secondary" size="sm" onClick={onRetry}>Try again</Button>}
      <Reference error={error} />
    </div>
  );
}

/** The discreet "Reference: <requestId>" line. */
export function Reference({ error, requestId, className }: { error?: unknown; requestId?: string | null; className?: string }) {
  const id = requestId ?? (error as ApiError | undefined)?.requestId;
  if (!id) return null;
  return <p className={cn('text-xs text-muted tabular', className)}>Reference: <span className="select-all">{id}</span></p>;
}

/** Product image: fixed 4:5 well, neutral background, lazy, with a quiet placeholder when it fails. */
export function ProductImage({ src, alt, className, priority = false, sizes }:
  { src?: string | null; alt: string; className?: string; priority?: boolean; sizes?: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={cn('relative aspect-[4/5] w-full overflow-hidden rounded-lg bg-surface-2', className)}>
      {src && !failed ? (
        <img src={src} alt={alt} sizes={sizes} loading={priority ? 'eager' : 'lazy'} decoding="async" fetchPriority={priority ? 'high' : 'auto'}
          onError={() => setFailed(true)} className="size-full object-cover" />
      ) : (
        <div role="img" aria-label={alt} className="grid size-full place-items-center text-faint">
          <svg viewBox="0 0 48 48" className="size-10" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="8" y="10" width="32" height="28" rx="3" /><path d="m8 32 9-9 8 8 5-5 10 10" /><circle cx="31" cy="18" r="3" />
          </svg>
        </div>
      )}
    </div>
  );
}
