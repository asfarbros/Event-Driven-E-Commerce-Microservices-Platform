import { formatPaise, isAmount } from '@/lib/money';
import { cn } from '@/lib/cn';

const sizes = { sm: 'text-sm', md: 'text-base', lg: 'text-xl', xl: 'text-3xl' } as const;

/**
 * The only way money is rendered in the UI. Tabular numerals so amounts align
 * in columns; a missing amount renders calm text ("Price unavailable"), never
 * ₹0.00 or NaN — Cart's degraded mode and unpriced lines rely on this.
 */
export function Price({ paise, currency = 'INR', className, unavailableText = 'Price unavailable', size = 'md', muted = false }:
  { paise: number | null | undefined; currency?: string; className?: string; unavailableText?: string; size?: keyof typeof sizes; muted?: boolean }) {
  if (!isAmount(paise)) {
    return <span className={cn('italic text-muted', size === 'xl' ? 'text-lg' : 'text-sm', className)}>{unavailableText}</span>;
  }
  return <span className={cn('tabular font-semibold', muted ? 'text-muted' : 'text-ink', sizes[size], className)}>{formatPaise(paise, currency)}</span>;
}
