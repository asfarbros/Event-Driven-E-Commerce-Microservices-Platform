# OrderFlow storefront (`apps/client-ui`)

The customer-facing store: browse, cart, checkout with Razorpay (India's
2FA payment flow), and a live order-status page that watches the backend saga.
React 19 · Vite 7 · TypeScript · Tailwind CSS v4 · `@clerk/clerk-react` ·
React Router 7 · TanStack Query 5 · Razorpay Checkout.

The browser talks **only to the API Gateway** (`VITE_API_BASE_URL`). It never
sends a price or a user id; every amount it shows is an integer number of
paise computed by the server and formatted by one function.

## Run it

```bash
# host (dev server with HMR) — the backend stack must be up (./orderflow.sh up, or the infra + services on the host)
cd apps/client-ui
npm install
npm run dev              # http://localhost:5173 — reads VITE_* from the ROOT .env (vite.config.ts: envDir = repo root)
npm run build            # production build → dist/ (dev-only pages are stripped)
npm run typecheck        # tsc -b
npm test                 # money formatting unit tests

# container — part of the one-command stack
./orderflow.sh up        # builds orderflow/client-ui (nginx, non-root, :5173) alongside the 7 services
```

Both modes serve the store at `http://localhost:5173`, so one CORS origin
covers both (`CORS_ALLOWED_ORIGINS` in `.env` lists `http://localhost:5173`
and `http://127.0.0.1:5173`). The dev server also mounts two **dev-only**
routes that a production build does not contain: `/dev/styleguide` (every
token and primitive) and `/dev/sign-in-with-ticket` (used by the automated
verification to sign in with a Clerk sign-in token).

## Environment variables (root `.env`, all PUBLIC — baked into the bundle)

| Variable | Purpose |
| --- | --- |
| `VITE_API_BASE_URL` | the API Gateway as the browser reaches it (`http://localhost:4000` on the host and in Compose — the browser runs on the host either way) |
| `VITE_CLERK_PUBLISHABLE_KEY` | Clerk **publishable** key (`pk_test_…`); validated at start-up, the secret key is never read |
| `VITE_RAZORPAY_KEY_ID` | Razorpay **key id** (`rzp_test_…`); public; the key secret stays on the Payment Service |
| `VITE_ORDER_POLL_INITIAL_MS`, `VITE_ORDER_POLL_MAX_MS`, `VITE_ORDER_POLL_BACKOFF_FACTOR`, `VITE_ORDER_POLL_TIMEOUT_MS` | status polling: first interval, ceiling, multiplier, when to stop and offer a manual refresh |
| `CLIENT_UI_PORT` | host port for the dev server and the nginx container (5173) |

Missing or malformed values stop the app with a readable page listing every
problem (`src/config/env.ts`, checked before anything renders). In Compose
the same values are passed as build args (`infra/docker-compose.services.yml`).

## Page map

| Route | Page | Auth |
| --- | --- | --- |
| `/` | product listing — grid, category chips, search, sort, server pagination (`?page&category&q&sort` in the URL) | public |
| `/products/:id` | product detail — 4:5 image, price, stock badge (signed in), quantity + add to cart, sticky bottom bar on phones | public (adding needs sign-in) |
| `/cart` | cart — quantity steppers (optimistic, rolled back on failure), remove, clear, server totals; **degraded mode** when Catalog is down | protected |
| `/checkout` | order summary + Pay ₹… (sticky on phones); out-of-stock / price-changed / unavailable handling | protected |
| `/orders/:id/status` | live status: the saga timeline, polling with backoff, "taking longer than expected", complete payment / cancel | protected |
| `/orders` | order history, paginated | protected |
| `/orders/:id` | order detail — lines, amounts, payment state, the timeline from the status history | protected |
| `/sign-in`, `/sign-up` | Clerk's components, themed from the tokens; `?redirect_url=` brings the user back | — |
| `/dev/styleguide`, `/dev/sign-in-with-ticket` | dev only (absent from production builds) | — |

The header has a cart button with a count badge and a slide-in cart drawer.
Protected routes redirect to `/sign-in?redirect_url=<where you were>`.

## Design tokens

Everything visual comes from [`src/styles/tokens.css`](src/styles/tokens.css)
(Tailwind v4 `@theme`); components use the generated utilities
(`bg-surface`, `text-muted`, `rounded-md`, `shadow-elevated` …) and never a
raw hex value or a one-off size.

- **Colour** — page `#FAFAF7` (warm off-white), surfaces white, ink `#18181B`,
  muted `#5F5E6B` (AA on both grounds), warm borders. **Accent: deep indigo
  `#3D3A8C`**, used only for primary actions, links and focus rings. Indigo
  rather than forest green because the semantic status palette already owns
  green for *confirmed*; an indigo accent can never be mistaken for success
  and stays distinct from amber (in progress), red (failed) and grey
  (cancelled).
- **Type** — Fraunces (display: headings and product names, sparingly) +
  Plus Jakarta Sans (UI/body), Google Fonts with `display=swap` and real
  fallback stacks; `tabular-nums` on every price and quantity.
- **Shape & depth** — 1 px borders, radii 6/8/12/16 px; a shadow only on the
  drawer, modal, toast and popover.
- **Space** — 4 px base unit on an 8 px rhythm, 1200 px max content width,
  ~65-character running text.
- **Motion** — 150–250 ms; `prefers-reduced-motion` removes it.

Primitives (`src/components/ui`): `Button` (primary / secondary / ghost /
danger, sizes, loading), `ButtonLink`, `Input`, `Select`, `Card`, `Badge`,
`StatusPill`, `Skeleton` (+ card/line skeletons), `Price`, `QuantityStepper`,
`Toast` (provider + `useToast`), `Drawer`, `Modal` (focus trap, Escape,
scroll lock), `EmptyState`, `ErrorState`, `Reference`, `ProductImage`,
`Spinner`. The signature element is `features/orders/StatusTimeline`.

## The API layer (`src/api`)

- `client.ts` — the one `api()` function: base URL, `Authorization: Bearer`
  from the Clerk token provider registered by `<AuthBridge>`, a fresh
  `X-Request-Id` per call (echoed by the Gateway; it is the trace id), JSON
  parsing, and the backend's `{ error, message, requestId, details }` turned
  into an `ApiError`. On 401 it refreshes the token once (`skipCache`) and
  retries; a second 401 emits an event the app turns into a redirect to
  sign-in with a return URL.
- `errors.ts` — `describeError()` maps every code to calm copy (401,
  `cart_empty`, `insufficient_stock` with the short items, `price_changed`,
  503 "temporarily unavailable — nothing has been charged", network,
  timeout…); `isRetryable()` decides where a "Try again" appears; the
  `Reference: <requestId>` line is rendered by `<Reference>`.
- `queries.ts` — TanStack Query keys, fetchers and mutations. Transient
  failures retry with backoff; cart quantity/remove are optimistic with
  rollback; totals are never computed in the browser (an in-flight line
  shows "Updating…" until the server answers).

## The checkout flow

`features/checkout/useCheckoutFlow.ts` implements the India/RBI shape — a
synchronous, user-present zone, then an asynchronous zone the browser only
*watches*:

1. **Pay** → `POST /api/orders/` with a stable `Idempotency-Key` for this
   attempt (`lib/idempotency.ts`: one UUID per cart state, kept in
   sessionStorage and reused on retry; a changed cart gets a new key). The
   button is disabled immediately, but the key is the real protection: a
   second request returns the *same* order (`200 created:false`).
2. The backend answers with our `orderId` and what Razorpay needs
   (`razorpayOrderId`, key id, `amountInPaise`, currency). Amounts come from
   the server, never from the page.
3. Razorpay's checkout script opens the widget with those values, themed with
   the accent colour. OTP / UPI PIN happen between the customer and Razorpay.
4. **The browser callback is not the source of truth.** Whatever the widget
   reports — success, failure, dismissal, a script that failed to load, or an
   iframe that never loaded (a top-layer *popover* offers "Continue to your
   order" after 8 s, since nothing under Razorpay's overlay is clickable) — the
   app navigates to `/orders/:id/status` and **polls the backend**. The
   backend learns the real outcome from Razorpay's signed webhook; the
   callback can be lost with a closed tab or arrive before the webhook. The
   `?outcome=` only words the interim message; an order is shown as confirmed
   when the server says `CONFIRMED`.
5. On the status page the user can *Complete payment* (reopens the widget for
   an `AWAITING_PAYMENT` order) or *Cancel order*; a confirmed order offers
   *Cancel and refund*.

Errors at step 1 are handled in place: `409 insufficient_stock` names the
products and their availability and links to the cart; `price_changed`
(policy `proceed` → the 201 carries `priceChanges`) shows old vs new and
requires confirmation before the widget opens — declining cancels the order;
`cart_empty` returns to the cart; 503 shows a retry with the same key.

## Order status polling (`features/orders/useOrderStatusPolling.ts`)

`GET /api/orders/:id/status` with TanStack Query: interval
`min(initial × factor^n, max)` (defaults 1 s → 2 s → 4 s → 8 s), stops on a
terminal state (`CONFIRMED` / `FAILED` / `CANCELLED`) and after
`VITE_ORDER_POLL_TIMEOUT_MS` (then "This is taking longer than expected" with
a manual *Check again* that resets the window), pauses while the tab is
hidden and refetches on focus. Whenever the status changes the full order
(with its history) is refetched so the timeline updates; status changes are
announced through an `aria-live` region.

## Money

`src/lib/money.ts` — `formatPaise(129900) → "₹1,299.00"`,
`formatPaise(10000000) → "₹1,00,000.00"`, exact integer arithmetic with Indian
grouping; a missing amount renders "—" and the `<Price>` primitive shows
"Price unavailable" / "Updating…" instead of ₹0.00 or NaN. `npm test` covers
zero, one paisa, lakh/crore values, `MAX_SAFE_INTEGER` and bad input.
