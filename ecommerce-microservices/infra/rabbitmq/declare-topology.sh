#!/usr/bin/env sh
# -----------------------------------------------------------------------------
# OrderFlow — RabbitMQ notification topology (Step 6, retry tiers + compose
# mode added in Step 8)
#
# Declares, through the management HTTP API, every durable object the Order
# Service publishes to and the Notification Worker consumes from. Both services
# ALSO declare the same objects on start-up (order: rabbit/RabbitTopology.java,
# notification: src/rabbit/topology.js) with IDENTICAL arguments, so nothing
# here can conflict with them — the declarations are idempotent whichever side
# runs first. (A differing argument is the one thing RabbitMQ refuses; every
# argument below is therefore copied from those two files, not invented.)
#
#   exchange  notifications       (topic, durable)
#      └─ order.*  ──►  queue notification.tasks           (durable, x-dead-letter-exchange = notifications.dlx)
#   exchange  notifications.dlx   (topic, durable)
#      └─ #        ──►  queue notification.tasks.dlq       (durable)
#   queue notification.tasks.retry.<delay>ms  one per backoff step
#      (durable, x-message-ttl = <delay>, x-dead-letter-exchange = "" (default),
#       x-dead-letter-routing-key = notification.tasks)  ← TTL expiry sends the
#      message straight back to the work queue: the worker's delayed retry.
#
# Why a task queue here and Kafka for the saga: a notification is a COMMAND
# ("send this customer one e-mail") that exactly one worker performs, acks
# when done, retries on failure and parks in the DLQ when it keeps failing.
# The saga's messages are EVENTS that several consumer groups read and replay.
#
# TWO WAYS TO RUN — same script, same result:
#   host     (from the PROJECT ROOT, stack up; needs curl)
#              sh infra/rabbitmq/declare-topology.sh          # declare
#              sh infra/rabbitmq/declare-topology.sh --list   # show
#            → sources .env and talks to http://localhost:$RABBITMQ_MANAGEMENT_PORT
#   compose  the `rabbitmq-init` service runs this file in a curl image with
#            RABBITMQ_API=http://rabbitmq:15672/api and the names in its
#            environment; services wait on it (service_completed_successfully).
# -----------------------------------------------------------------------------
set -eu

if [ -z "${RABBITMQ_API:-}" ]; then
  ENV_FILE="${ENV_FILE:-.env}"
  [ -f "$ENV_FILE" ] || { echo "error: $ENV_FILE not found — run from the project root" >&2; exit 1; }
  case "$ENV_FILE" in */*) ;; *) ENV_FILE="./$ENV_FILE" ;; esac   # POSIX "." searches PATH for bare names
  set -a; . "$ENV_FILE"; set +a
  RABBITMQ_API="http://localhost:${RABBITMQ_MANAGEMENT_PORT:?}/api"
fi
: "${RABBITMQ_USER:?}" "${RABBITMQ_PASSWORD:?}" "${RABBITMQ_VHOST:?}"
: "${RABBITMQ_NOTIFICATION_EXCHANGE:?}" "${RABBITMQ_NOTIFICATION_QUEUE:?}" "${RABBITMQ_NOTIFICATION_DLX:?}" "${RABBITMQ_NOTIFICATION_DLQ:?}"
: "${RABBITMQ_NOTIFICATION_RETRY_QUEUE:?}" "${RABBITMQ_NOTIFICATION_MAX_RETRIES:?}" "${RABBITMQ_NOTIFICATION_RETRY_DELAY_MS:?}"
MULT="${NOTIFICATION_RETRY_BACKOFF_MULTIPLIER:-1}"

# URL-encode the vhost: "/" (the default) is %2F; other names are used as-is.
case "$RABBITMQ_VHOST" in /) VHOST=%2F ;; *) VHOST="$RABBITMQ_VHOST" ;; esac

api() { # method path [json] → prints HTTP status
  if [ $# -ge 3 ]; then
    curl -s -o /dev/null -w '%{http_code}' -u "$RABBITMQ_USER:$RABBITMQ_PASSWORD" -H 'Content-Type: application/json' -X "$1" "$RABBITMQ_API/$2" -d "$3"
  else
    curl -s -o /dev/null -w '%{http_code}' -u "$RABBITMQ_USER:$RABBITMQ_PASSWORD" -X "$1" "$RABBITMQ_API/$2"
  fi
}
check() { # fail loudly on anything but created/existed
  case "$1" in 201|204) echo "HTTP $1" ;; *) echo "HTTP $1 — FAILED" >&2; exit 1 ;; esac
}

# The retry delays exactly as the worker computes them: delay × mult^(k-1), rounded.
retry_delays() {
  awk -v n="$RABBITMQ_NOTIFICATION_MAX_RETRIES" -v d="$RABBITMQ_NOTIFICATION_RETRY_DELAY_MS" -v m="$MULT" \
    'BEGIN { for (k = 0; k < n; k++) printf "%d\n", int(d * (m ^ k) + 0.5) }'
}

if [ "${1:-}" = "--list" ]; then
  echo "exchanges:"; curl -s -u "$RABBITMQ_USER:$RABBITMQ_PASSWORD" "$RABBITMQ_API/exchanges/$VHOST" | tr '{' '\n' | grep -o '"name":"[^"]*","type":"[^"]*"' | grep -v '"name":""' | grep -v 'amq\.' | sed 's/"name":"/  /; s/","type":"/  /; s/"$//'
  echo "queues:";    curl -s -u "$RABBITMQ_USER:$RABBITMQ_PASSWORD" "$RABBITMQ_API/queues/$VHOST?columns=name,messages,arguments" | tr '{' '\n' | grep '"name"' | sed 's/^/  /'
  echo "bindings:";  curl -s -u "$RABBITMQ_USER:$RABBITMQ_PASSWORD" "$RABBITMQ_API/bindings/$VHOST?columns=source,routing_key,destination" | tr '{' '\n' | grep '"source":"[^"]' | sed 's/^/  /'
  exit 0
fi

n=0
until [ "$(api GET overview)" = 200 ]; do
  n=$((n + 1)); [ "$n" -gt 30 ] && { echo "error: management API at $RABBITMQ_API not reachable" >&2; exit 1; }
  echo ">>> [rabbitmq] waiting for $RABBITMQ_API ($n)"; sleep 2
done

printf '>>> [rabbitmq] exchange %-34s ' "$RABBITMQ_NOTIFICATION_EXCHANGE (topic)"; check "$(api PUT "exchanges/$VHOST/$RABBITMQ_NOTIFICATION_EXCHANGE" '{"type":"topic","durable":true}')"
printf '>>> [rabbitmq] exchange %-34s ' "$RABBITMQ_NOTIFICATION_DLX (topic)";      check "$(api PUT "exchanges/$VHOST/$RABBITMQ_NOTIFICATION_DLX" '{"type":"topic","durable":true}')"
printf '>>> [rabbitmq] queue    %-34s ' "$RABBITMQ_NOTIFICATION_QUEUE";            check "$(api PUT "queues/$VHOST/$RABBITMQ_NOTIFICATION_QUEUE" "{\"durable\":true,\"arguments\":{\"x-dead-letter-exchange\":\"$RABBITMQ_NOTIFICATION_DLX\"}}")"
printf '>>> [rabbitmq] queue    %-34s ' "$RABBITMQ_NOTIFICATION_DLQ";              check "$(api PUT "queues/$VHOST/$RABBITMQ_NOTIFICATION_DLQ" '{"durable":true}')"
printf '>>> [rabbitmq] binding  %-34s ' "$RABBITMQ_NOTIFICATION_EXCHANGE --(order.*)--> $RABBITMQ_NOTIFICATION_QUEUE"; check "$(api POST "bindings/$VHOST/e/$RABBITMQ_NOTIFICATION_EXCHANGE/q/$RABBITMQ_NOTIFICATION_QUEUE" '{"routing_key":"order.*"}')"
printf '>>> [rabbitmq] binding  %-34s ' "$RABBITMQ_NOTIFICATION_DLX --(#)--> $RABBITMQ_NOTIFICATION_DLQ";              check "$(api POST "bindings/$VHOST/e/$RABBITMQ_NOTIFICATION_DLX/q/$RABBITMQ_NOTIFICATION_DLQ" '{"routing_key":"#"}')"
for delay in $(retry_delays); do
  q="$RABBITMQ_NOTIFICATION_RETRY_QUEUE.${delay}ms"
  printf '>>> [rabbitmq] queue    %-34s ' "$q (ttl $delay)"
  check "$(api PUT "queues/$VHOST/$q" "{\"durable\":true,\"arguments\":{\"x-message-ttl\":$delay,\"x-dead-letter-exchange\":\"\",\"x-dead-letter-routing-key\":\"$RABBITMQ_NOTIFICATION_QUEUE\"}}")"
done
echo ">>> [rabbitmq] done (201 = created, 204 = already existed)"
