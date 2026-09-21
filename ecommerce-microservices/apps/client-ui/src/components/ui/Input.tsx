import { forwardRef, useId, type InputHTMLAttributes, type SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

const field =
  'h-11 w-full rounded-md border border-border-strong bg-surface px-3 text-base text-ink placeholder:text-faint ' +
  'transition-colors duration-(--duration-fast) hover:border-ink-2 disabled:bg-surface-2 disabled:text-muted ' +
  'aria-invalid:border-danger';

interface FieldProps { label?: string; hint?: string; error?: string; }

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & FieldProps>(
  function Input({ label, hint, error, className, id, ...rest }, ref) {
    const autoId = useId();
    const inputId = id ?? autoId;
    return (
      <div className="flex flex-col gap-1.5">
        {label && <label htmlFor={inputId} className="text-sm font-medium text-ink">{label}</label>}
        <input ref={ref} id={inputId} aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined}
          className={cn(field, className)} {...rest} />
        {error ? <p id={`${inputId}-error`} className="text-sm text-danger">{error}</p>
          : hint ? <p id={`${inputId}-hint`} className="text-sm text-muted">{hint}</p> : null}
      </div>
    );
  });

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & FieldProps>(
  function Select({ label, hint, className, id, children, ...rest }, ref) {
    const autoId = useId();
    const selectId = id ?? autoId;
    return (
      <div className="flex flex-col gap-1.5">
        {label && <label htmlFor={selectId} className="text-sm font-medium text-ink">{label}</label>}
        <div className="relative">
          <select ref={ref} id={selectId} className={cn(field, 'appearance-none pr-9', className)} {...rest}>{children}</select>
          <svg aria-hidden="true" viewBox="0 0 20 20" className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted">
            <path d="M5 7.5 10 12.5 15 7.5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        {hint && <p className="text-sm text-muted">{hint}</p>}
      </div>
    );
  });
