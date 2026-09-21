import { useState } from 'react';
import { Container } from '@/components/layout/Shell';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Input';
import { Card, CardSection } from '@/components/ui/Card';
import { Badge, StatusPill } from '@/components/ui/Badge';
import { Skeleton, ProductCardSkeleton } from '@/components/ui/Skeleton';
import { Price } from '@/components/ui/Price';
import { QuantityStepper } from '@/components/ui/QuantityStepper';
import { Drawer, Modal } from '@/components/ui/Overlay';
import { useToast } from '@/components/ui/Toast';
import { EmptyState, ErrorState, ProductImage } from '@/components/ui/States';
import { ApiError } from '@/api/errors';
import { StatusTimeline } from '@/features/orders/StatusTimeline';
import type { HistoryEntry } from '@/api/types';

const colors = [
  ['page', '--color-page'], ['surface', '--color-surface'], ['surface-2', '--color-surface-2'], ['border', '--color-border'], ['border-strong', '--color-border-strong'],
  ['ink', '--color-ink'], ['ink-2', '--color-ink-2'], ['muted', '--color-muted'], ['faint', '--color-faint'],
  ['accent', '--color-accent'], ['accent-hover', '--color-accent-hover'], ['accent-soft', '--color-accent-soft'],
  ['success', '--color-success'], ['success-soft', '--color-success-soft'], ['warning', '--color-warning'], ['warning-soft', '--color-warning-soft'],
  ['danger', '--color-danger'], ['danger-soft', '--color-danger-soft'], ['neutral', '--color-neutral'], ['neutral-soft', '--color-neutral-soft'],
];

const sampleHistory: HistoryEntry[] = [
  { from: null, to: 'PENDING', trigger: 'CHECKOUT', reason: 'order placed from cart snapshot', eventId: null, requestId: 'demo', at: '2026-09-21T08:09:04.819Z' },
  { from: 'PENDING', to: 'RESERVED', trigger: 'CHECKOUT', reason: 'inventory hold 7b3647a2', eventId: null, requestId: 'demo', at: '2026-09-21T08:09:04.888Z' },
  { from: 'RESERVED', to: 'AWAITING_PAYMENT', trigger: 'CHECKOUT', reason: 'razorpay order created', eventId: null, requestId: 'demo', at: '2026-09-21T08:09:08.258Z' },
  { from: 'AWAITING_PAYMENT', to: 'CONFIRMED', trigger: 'PAYMENT_EVENT', reason: 'payment succeeded', eventId: 'evt', requestId: 'demo', at: '2026-09-21T08:09:08.328Z' },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-2xl">{title}</h2>
      {children}
    </section>
  );
}

/** /dev/styleguide — every token and primitive in every state. Dev only: excluded from production builds. */
export function StyleGuidePage() {
  const { toast } = useToast();
  const [drawer, setDrawer] = useState(false);
  const [modal, setModal] = useState(false);
  const [qty, setQty] = useState(2);

  return (
    <Container className="flex flex-col gap-14 py-10">
      <header>
        <p className="eyebrow">Development</p>
        <h1 className="mt-1 text-4xl">Style guide</h1>
        <p className="mt-2 max-w-prose text-muted">Every design token and primitive, in all its states, from <code className="text-sm">src/styles/tokens.css</code>. Not shipped in production builds.</p>
      </header>

      <Section title="Colour">
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
          {colors.map(([name, v]) => (
            <li key={name} className="flex flex-col gap-2">
              <div className="h-14 rounded-md border border-border" style={{ background: `var(${v})` }} />
              <p className="text-sm font-medium">{name}</p><p className="-mt-2 text-xs text-faint">{v}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Typography">
        <div className="flex flex-col gap-3">
          <p className="font-display text-5xl">Fraunces display — product names & headings</p>
          <p className="font-display text-3xl">The quick brown fox jumps over the lazy dog</p>
          <p className="text-xl">Plus Jakarta Sans — UI and body, xl</p>
          <p className="text-base max-w-prose">Body text at base size keeps to roughly sixty-five characters per line so it stays comfortable to read at any width, on any device, in any light.</p>
          <p className="text-sm text-muted">Small muted text — secondary information, still AA contrast.</p>
          <p className="eyebrow">Eyebrow label</p>
          <p className="tabular text-2xl font-semibold">₹1,00,000.00 · 0123456789 tabular</p>
        </div>
      </Section>

      <Section title="Buttons">
        <div className="flex flex-wrap items-center gap-3">
          <Button>Primary</Button><Button variant="secondary">Secondary</Button><Button variant="ghost">Ghost</Button><Button variant="danger">Danger</Button>
          <Button loading>Paying…</Button><Button disabled>Disabled</Button><Button size="sm">Small</Button><Button size="lg">Pay ₹1,299.00</Button>
          <ButtonLink to="/" variant="secondary">Link as button</ButtonLink>
        </div>
      </Section>

      <Section title="Inputs">
        <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
          <Input label="Search" placeholder="Search products" hint="Press Enter to search" />
          <Input label="With error" defaultValue="oops" error="That doesn’t look right" />
          <Select label="Sort by" defaultValue="newest"><option value="newest">Newest</option><option value="price_asc">Price: low to high</option></Select>
          <Input label="Disabled" disabled defaultValue="Not editable" />
        </div>
      </Section>

      <Section title="Badges & status pills">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>Neutral</Badge><Badge tone="accent">Accent</Badge><Badge tone="success">Success</Badge><Badge tone="warning">Warning</Badge><Badge tone="danger">Danger</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(['PENDING', 'RESERVED', 'AWAITING_PAYMENT', 'CONFIRMED', 'FAILED', 'CANCELLED'] as const).map((s) => <StatusPill key={s} status={s} live={s === 'AWAITING_PAYMENT'} />)}
        </div>
      </Section>

      <Section title="Price display">
        <div className="flex flex-wrap items-baseline gap-6">
          <Price paise={129900} size="xl" /><Price paise={10000000} size="lg" /><Price paise={0} /><Price paise={1} size="sm" /><Price paise={null} /><Price paise={null} unavailableText="Updating…" />
        </div>
      </Section>

      <Section title="Quantity stepper">
        <div className="flex items-center gap-4"><QuantityStepper value={qty} onChange={setQty} /><QuantityStepper value={1} onChange={() => {}} size="sm" /><QuantityStepper value={3} onChange={() => {}} disabled /></div>
      </Section>

      <Section title="Cards, image, skeletons">
        <div className="grid gap-4 sm:grid-cols-3">
          <Card><CardSection><p className="font-medium">Card</p><p className="text-sm text-muted">Thin border, no shadow.</p></CardSection></Card>
          <div className="w-40"><ProductImage src={null} alt="Placeholder when an image fails" /></div>
          <div className="w-40"><ProductCardSkeleton /></div>
        </div>
        <Skeleton className="h-4 w-1/2" />
      </Section>

      <Section title="Overlays & toasts (elevated layers — the only shadows)">
        <div className="flex flex-wrap gap-3">
          <Button variant="secondary" onClick={() => setDrawer(true)}>Open drawer</Button>
          <Button variant="secondary" onClick={() => setModal(true)}>Open modal</Button>
          <Button variant="secondary" onClick={() => toast({ tone: 'success', title: 'Added to cart', description: 'Ripple Portable Bluetooth Speaker × 1', action: { label: 'View cart', onClick: () => {} } })}>Success toast</Button>
          <Button variant="secondary" onClick={() => toast({ tone: 'danger', title: 'We can’t reach the store right now', description: 'Check your connection and try again.' })}>Error toast</Button>
        </div>
        <Drawer open={drawer} onClose={() => setDrawer(false)} title="Your cart" footer={<Button full>Checkout</Button>}><p className="text-muted">Drawer content.</p></Drawer>
        <Modal open={modal} onClose={() => setModal(false)} title="A price has changed" footer={<><Button variant="secondary" onClick={() => setModal(false)}>Back to cart</Button><Button onClick={() => setModal(false)}>Pay ₹1,299.00</Button></>}>
          <p className="text-muted">Modal content with the confirmation copy.</p>
        </Modal>
      </Section>

      <Section title="States">
        <div className="grid gap-4 lg:grid-cols-2">
          <EmptyState title="Your cart is empty" description="Find something you like in the shop." action={<Button variant="secondary">Continue shopping</Button>} />
          <ErrorState error={new ApiError(503, 'inventory_unavailable', 'x', '3d2d9e0c-4b48-42b0-9b5f-7f35c05c87e7')} onRetry={() => {}} />
        </div>
      </Section>

      <Section title="Order status timeline (signature element)">
        <div className="grid gap-6 lg:grid-cols-2">
          <Card><CardSection><StatusTimeline status="AWAITING_PAYMENT" history={sampleHistory.slice(0, 3)} live /></CardSection></Card>
          <Card><CardSection><StatusTimeline status="CONFIRMED" history={sampleHistory} /></CardSection></Card>
        </div>
      </Section>
    </Container>
  );
}
