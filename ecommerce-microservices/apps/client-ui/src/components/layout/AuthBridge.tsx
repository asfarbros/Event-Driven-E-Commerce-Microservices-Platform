import { useEffect } from 'react';
import { useAuth } from '@clerk/clerk-react';
import { useLocation, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { setTokenProvider, UNAUTHORIZED_EVENT } from '@/api/client';

/**
 * Connects Clerk to the API client once, for the whole app:
 *   - registers the token provider (`getToken`, with skipCache for the refresh-and-retry)
 *   - when a request is rejected even after a refresh, routes to sign-in and
 *     remembers where the user was so they come back afterwards
 *   - drops the user's cached server state on sign-out so nothing leaks between accounts
 */
export function AuthBridge() {
  const { getToken, isSignedIn, userId } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();

  useEffect(() => {
    setTokenProvider(async (opts) => (isSignedIn ? getToken({ skipCache: opts?.skipCache }) : null));
    return () => setTokenProvider(null);
  }, [getToken, isSignedIn]);

  useEffect(() => {
    const onUnauthorized = () => {
      const returnTo = `${location.pathname}${location.search}`;
      navigate(`/sign-in?redirect_url=${encodeURIComponent(returnTo)}`, { replace: true });
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [navigate, location.pathname, location.search]);

  useEffect(() => {
    // A different (or no) user: the cart and orders in the cache belong to someone else.
    qc.removeQueries({ queryKey: ['cart'] });
    qc.removeQueries({ queryKey: ['orders'] });
    qc.removeQueries({ queryKey: ['order'] });
    qc.removeQueries({ queryKey: ['order-status'] });
    qc.removeQueries({ queryKey: ['stock'] });
  }, [userId, qc]);

  return null;
}
