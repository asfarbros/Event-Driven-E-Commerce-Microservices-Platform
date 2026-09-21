import { useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router';
import { useSignIn } from '@clerk/clerk-react';
import { Container } from '@/components/layout/Shell';

/**
 * DEV ONLY (excluded from production builds): signs in with a Clerk
 * sign-in token (Backend API `POST /v1/sign_in_tokens`), so the automated
 * verification (Playwright) can exercise the protected flow without driving
 * Clerk's email-code UI. Nothing here is reachable in a production bundle.
 *
 *   /dev/sign-in-with-ticket?ticket=<token>&redirect_url=/cart
 */
export function DevTicketSignInPage() {
  const [params] = useSearchParams();
  const { signIn, setActive, isLoaded } = useSignIn();
  const navigate = useNavigate();
  const [state, setState] = useState<'working' | 'done' | 'error'>('working');
  const [message, setMessage] = useState('Signing in…');

  useEffect(() => {
    if (!isLoaded) return;
    const ticket = params.get('ticket');
    const to = params.get('redirect_url') || '/';
    if (!ticket) { setState('error'); setMessage('Missing ?ticket='); return; }
    (async () => {
      try {
        const result = await signIn.create({ strategy: 'ticket', ticket });
        if (result.status !== 'complete' || !result.createdSessionId) throw new Error(`sign-in status ${result.status}`);
        await setActive({ session: result.createdSessionId });
        setState('done');
        navigate(to, { replace: true });
      } catch (err) {
        setState('error');
        setMessage(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [isLoaded, params, signIn, setActive, navigate]);

  return <Container className="py-12"><p data-state={state} className="text-muted">{message}</p></Container>;
}
