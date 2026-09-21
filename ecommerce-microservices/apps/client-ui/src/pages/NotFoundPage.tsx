import { Container } from '@/components/layout/Shell';
import { ButtonLink } from '@/components/ui/Button';
import { Reference } from '@/components/ui/States';

/** Also used when the backend answers 404 for an order that isn’t the user’s (ids can’t be probed). */
export function NotFoundPage({ title = 'We couldn’t find that page', description = 'It may have moved, or the link may be incorrect.', requestId }:
  { title?: string; description?: string; requestId?: string | null }) {
  return (
    <Container className="flex flex-col items-start gap-4 py-16">
      <p className="eyebrow">Not found</p>
      <h1 className="text-3xl sm:text-4xl">{title}</h1>
      <p className="max-w-prose text-muted">{description}</p>
      <div className="flex gap-2 pt-2">
        <ButtonLink to="/">Back to the shop</ButtonLink>
        <ButtonLink to="/orders" variant="secondary">Your orders</ButtonLink>
      </div>
      <Reference requestId={requestId} />
    </Container>
  );
}
