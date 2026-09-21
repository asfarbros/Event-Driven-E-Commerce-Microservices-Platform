import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/** A quiet surface: white, 1px border, modest radius, no shadow (depth is reserved for overlays). */
export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-lg border border-border bg-surface', className)} {...rest} />;
}

export function CardSection({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-4 sm:p-5', className)} {...rest} />;
}
