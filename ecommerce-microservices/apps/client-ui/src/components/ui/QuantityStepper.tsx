import { cn } from '@/lib/cn';

export function QuantityStepper({ value, onChange, min = 1, max = 10, disabled = false, label = 'Quantity', size = 'md' }:
  { value: number; onChange: (next: number) => void; min?: number; max?: number; disabled?: boolean; label?: string; size?: 'sm' | 'md' }) {
  const h = size === 'sm' ? 'h-9' : 'h-11';
  const btn = cn(
    'grid place-items-center text-ink transition-colors duration-(--duration-fast) hover:not-disabled:bg-surface-2 disabled:text-faint disabled:cursor-not-allowed',
    size === 'sm' ? 'w-9' : 'w-11',
  );
  return (
    <div role="group" aria-label={label} className={cn('inline-flex items-stretch overflow-hidden rounded-md border border-border-strong bg-surface', h)}>
      <button type="button" className={btn} aria-label="Decrease quantity" disabled={disabled || value <= min} onClick={() => onChange(value - 1)}>
        <svg viewBox="0 0 20 20" className="size-4" aria-hidden="true"><path d="M5 10h10" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" /></svg>
      </button>
      <output aria-live="polite" className="grid min-w-10 place-items-center border-x border-border-strong px-2 text-sm font-semibold tabular">{value}</output>
      <button type="button" className={btn} aria-label="Increase quantity" disabled={disabled || value >= max} onClick={() => onChange(value + 1)}>
        <svg viewBox="0 0 20 20" className="size-4" aria-hidden="true"><path d="M10 5v10M5 10h10" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" /></svg>
      </button>
    </div>
  );
}
