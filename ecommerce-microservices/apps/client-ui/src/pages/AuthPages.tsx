import { SignIn, SignUp } from '@clerk/clerk-react';
import { useSearchParams } from 'react-router';
import { Container } from '@/components/layout/Shell';

/** Clerk's pre-built components, themed via styles/clerk.ts. `redirect_url` returns the user where they were. */
function safeRedirect(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/';
}

export function SignInPage() {
  const [params] = useSearchParams();
  const to = safeRedirect(params.get('redirect_url'));
  return (
    <Container className="flex justify-center py-12">
      <SignIn routing="path" path="/sign-in" signUpUrl={`/sign-up?redirect_url=${encodeURIComponent(to)}`} forceRedirectUrl={to} />
    </Container>
  );
}

export function SignUpPage() {
  const [params] = useSearchParams();
  const to = safeRedirect(params.get('redirect_url'));
  return (
    <Container className="flex justify-center py-12">
      <SignUp routing="path" path="/sign-up" signInUrl={`/sign-in?redirect_url=${encodeURIComponent(to)}`} forceRedirectUrl={to} />
    </Container>
  );
}
