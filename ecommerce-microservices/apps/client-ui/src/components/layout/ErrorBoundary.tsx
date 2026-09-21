import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';

interface State { error: Error | null }

/**
 * One broken component never blanks the whole app: the boundary renders a
 * calm recovery panel with a reload, and logs the error to the console (the
 * only place a stack trace belongs). Used at the app root and around each route.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; label?: string }, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: Error): State { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('[orderflow-ui] render error', error, info.componentStack); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="mx-auto my-16 flex max-w-md flex-col items-start gap-3 rounded-lg border border-border bg-surface p-6">
        <h2 className="text-2xl">This part of the page didn’t load</h2>
        <p className="text-muted">Nothing has been charged. Reloading usually fixes it.</p>
        <div className="flex gap-2">
          <Button onClick={() => this.setState({ error: null })} variant="secondary">Try again</Button>
          <Button onClick={() => window.location.reload()}>Reload page</Button>
        </div>
      </div>
    );
  }
}
