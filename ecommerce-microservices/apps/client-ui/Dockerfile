# syntax=docker/dockerfile:1.7
# -----------------------------------------------------------------------------
# OrderFlow storefront (React + Vite). Multi-stage:
#   build   installs with the lockfile and runs `vite build`. VITE_* values are
#           PUBLIC configuration baked into the bundle at build time — Compose
#           passes them as build args from the root .env (never a secret).
#   runtime nginx (unprivileged image: runs as uid 101, listens on 8080) serving
#           the static files with SPA fallback + immutable caching (nginx.conf).
#
#   docker build --build-arg VITE_API_BASE_URL=http://localhost:4000 … -t orderflow/client-ui apps/client-ui
# -----------------------------------------------------------------------------
FROM node:20.19-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY index.html vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json ./
COPY public ./public
COPY src ./src
ARG VITE_API_BASE_URL
ARG VITE_CLERK_PUBLISHABLE_KEY
ARG VITE_RAZORPAY_KEY_ID
ARG VITE_ORDER_POLL_INITIAL_MS=1000
ARG VITE_ORDER_POLL_MAX_MS=8000
ARG VITE_ORDER_POLL_BACKOFF_FACTOR=2
ARG VITE_ORDER_POLL_TIMEOUT_MS=120000
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL VITE_CLERK_PUBLISHABLE_KEY=$VITE_CLERK_PUBLISHABLE_KEY VITE_RAZORPAY_KEY_ID=$VITE_RAZORPAY_KEY_ID \
    VITE_ORDER_POLL_INITIAL_MS=$VITE_ORDER_POLL_INITIAL_MS VITE_ORDER_POLL_MAX_MS=$VITE_ORDER_POLL_MAX_MS \
    VITE_ORDER_POLL_BACKOFF_FACTOR=$VITE_ORDER_POLL_BACKOFF_FACTOR VITE_ORDER_POLL_TIMEOUT_MS=$VITE_ORDER_POLL_TIMEOUT_MS
# envDir points at the repo root, which is not in the build context — the ARG/ENV above are what Vite reads.
RUN npx vite build

FROM nginxinc/nginx-unprivileged:1.27.5-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY security-headers.inc /etc/nginx/conf.d/security-headers.inc
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
USER 101
