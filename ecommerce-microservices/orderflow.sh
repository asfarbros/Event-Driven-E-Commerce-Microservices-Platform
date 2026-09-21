#!/usr/bin/env bash
# =============================================================================
# OrderFlow — the one command. Run from the project root (the folder with .env).
#
#   ./orderflow.sh up                 build + start infra, messaging setup, all 7 services,
#                                     observability; wait for healthy; seed catalog + inventory
#   ./orderflow.sh up --no-build      reuse the images already built
#   ./orderflow.sh up --no-observability   skip Prometheus/Grafana/Jaeger (and trace export)
#   ./orderflow.sh up --debug-ports   also publish the internal services on the host (dev only)
#   ./orderflow.sh down               stop everything, KEEP data
#   ./orderflow.sh down -v            stop everything and wipe all volumes (cold start next time)
#   ./orderflow.sh ps | logs [svc] | stats
#   ./orderflow.sh seed               (re)seed catalog products + inventory rows — idempotent
#   ./orderflow.sh smoke              happy-path smoke test through the gateway (pass/fail)
#   ./orderflow.sh topics | queues    show the Kafka topics / RabbitMQ topology
#   ./orderflow.sh build              build the service images only
#
# Works from Git Bash on Windows, WSL, macOS and Linux. Needs docker (compose v2)
# and node ≥ 20 on the host for `smoke` (it mints a Clerk token with CLERK_SECRET_KEY).
# =============================================================================
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
[[ -f .env ]] || { echo "error: .env not found — cp .env.example .env and fill it in" >&2; exit 1; }

FILES=(-f infra/docker-compose.yml -f infra/docker-compose.services.yml)
OBS=1; BUILD=1
for a in "$@"; do
  case "$a" in
    --no-observability) OBS=0 ;;
    --no-build) BUILD=0 ;;
    --debug-ports) FILES+=(-f infra/docker-compose.debug-ports.yml) ;;
  esac
done
if [[ $OBS -eq 1 ]]; then FILES+=(-f infra/docker-compose.observability.yml); else export OTEL_SDK_DISABLED=true; fi
dc() { docker compose --env-file .env "${FILES[@]}" "$@"; }
port() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | tr -d '"'; }

wait_healthy() { # wait until every container of this project is healthy (or has exited 0)
  local deadline=$((SECONDS + ${1:-420}))
  while :; do
    local bad
    bad=$(docker ps -a --filter "label=com.docker.compose.project=orderflow" --format '{{.Names}} {{.Status}}' \
          | grep -Ev '\(healthy\)|Exited \(0\)' || true)
    [[ -z "$bad" ]] && return 0
    if (( SECONDS > deadline )); then echo "error: not healthy after ${1:-420}s:" >&2; echo "$bad" >&2; return 1; fi
    printf '\r>>> waiting for: %s   ' "$(echo "$bad" | awk '{print $1}' | tr '\n' ' ')"
    sleep 5
  done
}

case "${1:-}" in
  up)
    [[ $BUILD -eq 1 ]] && dc build --quiet
    dc up -d --remove-orphans
    wait_healthy 420
    echo; echo ">>> all containers healthy — seeding (idempotent)"
    "$0" seed
    echo
    echo "OrderFlow is up:"
    echo "  API Gateway      http://localhost:$(port GATEWAY_PORT)/health"
    [[ $OBS -eq 1 ]] && {
      echo "  Grafana          http://localhost:$(port GRAFANA_PORT)   ($(port GRAFANA_ADMIN_USER) / \$GRAFANA_ADMIN_PASSWORD)"
      echo "  Prometheus       http://localhost:$(port PROMETHEUS_PORT)/targets"
      echo "  Jaeger           http://localhost:$(port JAEGER_UI_PORT)"
    }
    echo "  Kafka UI         http://localhost:$(port KAFKA_UI_PORT)"
    echo "  RabbitMQ         http://localhost:$(port RABBITMQ_MANAGEMENT_PORT)"
    echo "  Mailpit          http://localhost:$(port MAILPIT_UI_PORT)"
    echo "Next: ./orderflow.sh smoke"
    ;;
  down)
    shift; dc down --remove-orphans "$@" ;;
  build)
    dc build ;;
  ps)
    docker ps -a --filter "label=com.docker.compose.project=orderflow" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' ;;
  logs)
    shift; dc logs -f --tail=200 "$@" ;;
  stats)
    docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}' $(docker ps -q --filter "label=com.docker.compose.project=orderflow") ;;
  seed)
    echo ">>> [seed] catalog products";  dc run --rm --no-deps -T catalog node scripts/seed.js
    echo ">>> [seed] inventory rows";    dc run --rm --no-deps -T inventory --spring.profiles.active=seed 2>&1 | grep -E '"msg"|seed' | tail -5 || true
    ;;
  smoke)
    node scripts/smoke-test.mjs ;;
  topics)
    bash infra/kafka/create-topics.sh --list ;;
  queues)
    sh infra/rabbitmq/declare-topology.sh --list ;;
  *)
    sed -n 2,20p "$0"; exit 2 ;;
esac
