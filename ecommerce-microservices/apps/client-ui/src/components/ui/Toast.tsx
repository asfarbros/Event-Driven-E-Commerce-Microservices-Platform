import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

type ToastTone = 'neutral' | 'success' | 'danger';
interface ToastItem { id: number; title: string; description?: string; tone: ToastTone; action?: { label: string; onClick: () => void } }
interface ToastApi { toast: (t: Omit<ToastItem, 'id'>) => void; dismiss: (id: number) => void }

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

const toneClass: Record<ToastTone, string> = {
  neutral: 'border-border',
  success: 'border-success/40',
  danger: 'border-danger/40',
};
const dot: Record<ToastTone, string> = { neutral: 'bg-accent', success: 'bg-success', danger: 'bg-danger' };

/** Bottom-right (bottom-centre on phones) stack; auto-dismiss after 5 s; announced via a polite live region. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const toast = useCallback((t: Omit<ToastItem, 'id'>) => {
    const id = ++seq.current;
    setItems((xs) => [...xs.slice(-3), { ...t, id }]);
    window.setTimeout(() => dismiss(id), t.tone === 'danger' ? 8000 : 5000);
  }, [dismiss]);
  const api = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div aria-live="polite" aria-atomic="false"
        className="pointer-events-none fixed inset-x-4 bottom-[calc(1rem+env(safe-area-inset-bottom,0px))] z-50 flex flex-col items-center gap-2 sm:inset-x-auto sm:right-6 sm:items-end">
        {items.map((t) => (
          <div key={t.id} role="status"
            className={cn('pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border bg-surface p-3.5 shadow-elevated animate-rise-in', toneClass[t.tone])}>
            <span aria-hidden="true" className={cn('mt-1.5 size-2 shrink-0 rounded-full', dot[t.tone])} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-ink">{t.title}</p>
              {t.description && <p className="mt-0.5 text-sm text-muted">{t.description}</p>}
              {t.action && (
                <button type="button" onClick={() => { t.action?.onClick(); dismiss(t.id); }}
                  className="mt-2 text-sm font-semibold text-accent hover:text-accent-hover">{t.action.label}</button>
              )}
            </div>
            <button type="button" onClick={() => dismiss(t.id)} aria-label="Dismiss" className="-m-1 rounded-sm p-1 text-muted hover:text-ink">
              <svg viewBox="0 0 20 20" className="size-4" aria-hidden="true"><path d="m6 6 8 8M14 6l-8 8" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" /></svg>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
