import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router';
import { cn } from '@/lib/cn';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const base =
  'inline-flex items-center justify-center gap-2 rounded-md font-semibold whitespace-nowrap select-none ' +
  'transition-[background-color,color,border-color,transform] duration-(--duration-fast) ' +
  'disabled:opacity-50 disabled:cursor-not-allowed active:not-disabled:translate-y-px';
const variants: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-ink hover:not-disabled:bg-accent-hover active:not-disabled:bg-accent-active',
  secondary: 'bg-surface text-ink border border-border-strong hover:not-disabled:bg-surface-2',
  ghost: 'bg-transparent text-ink hover:not-disabled:bg-surface-2',
  danger: 'bg-surface text-danger border border-danger/40 hover:not-disabled:bg-danger-soft',
};
const sizes: Record<ButtonSize, string> = {
  sm: 'h-9 px-3 text-sm',
  md: 'h-11 px-4 text-sm',
  lg: 'h-12 px-5 text-base',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  full?: boolean;
  leading?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading = false, full = false, leading, className, children, disabled, type = 'button', onClick, ...rest }, ref) {
  // A loading button stays focusable (a disabled control drops keyboard focus to <body>); clicks are ignored instead.
  return (
    <button ref={ref} type={type} disabled={disabled} aria-busy={loading || undefined} aria-disabled={loading || undefined}
      onClick={loading ? (e) => e.preventDefault() : onClick}
      className={cn(base, variants[variant], sizes[size], full && 'w-full', loading && 'cursor-progress opacity-80', className)} {...rest}>
      {loading ? <Spinner className="size-4" /> : leading}
      {children}
    </button>
  );
});

/** A router link that looks exactly like a button ("Continue shopping", "View order" …). */
export function ButtonLink({ variant = 'primary', size = 'md', full = false, className, children, ...rest }:
  LinkProps & { variant?: ButtonVariant; size?: ButtonSize; full?: boolean }) {
  return (
    <Link className={cn(base, variants[variant], sizes[size], full && 'w-full', className)} {...rest}>
      {children}
    </Link>
  );
}
