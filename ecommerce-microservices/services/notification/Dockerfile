# syntax=docker/dockerfile:1.7
# -----------------------------------------------------------------------------
# OrderFlow — notification (Node.js 20, ESM). Multi-stage: dependencies are
# installed once with the lockfile (production only), then copied onto a
# clean runtime image; the app runs as the unprivileged `node` user.
#
#   docker build -t orderflow/notification services/notification
#
# Configuration is environment only (the root .env is NOT baked in; Compose
# passes it with env_file + container-address overrides). Tracing is opt-in:
# the OpenTelemetry auto-instrumentation registers itself from OTEL_* env
# vars and is a no-op when OTEL_SDK_DISABLED=true.
# -----------------------------------------------------------------------------
FROM node:20.19-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund

FROM node:20.19-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
USER node
CMD ["node", "--import", "@opentelemetry/auto-instrumentations-node/register", "src/index.js"]
