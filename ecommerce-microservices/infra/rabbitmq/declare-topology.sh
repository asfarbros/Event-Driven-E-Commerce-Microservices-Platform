#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# OrderFlow — RabbitMQ notification topology (Step 6)
#
# Declares the durable objects the Order Service publishes to and the
# Notification Worker (Step 7) consumes from. The Order Service ALSO declares
# exactly these on start-up (rabbit/RabbitTopology.java) — both are
# idempotent, so running this first only means the queues exist before any
# service does (useful for demos and for the worker starting first).
#
#   exchange  notifications        (topic, durable)
#      └─ binding  order.*  ──►  queue notification.tasks   (durable, dead-letters to notifications.dlx)
#   exchange  notifications.dlx    (topic, durable)
#      └─ binding  #        ──►  queue notification.tasks.dlq (durable)
#
# Why a task queue here and Kafka for the saga: a notification is a COMMAND
# ("send this customer one e-mail") that exactly one worker performs, acks
# when done, retries on failure and parks in the DLQ when it keeps failing.
# The saga's messages are EVENTS that several consumer groups read and replay.
#
# Run from the PROJECT ROOT with the stack up:
#   bash infra/rabbitmq/declare-topology.sh
#   bash infra/rabbitmq/declare-topology.sh --list
# Uses the management HTTP API via curl (no rabbitmqadmin needed).
# -----------------------------------------------------------------------------
set -Eeuo pipefail

ENV_FILE="${ENV_FILE:-.env}"
[[ -f "$ENV_FILE" ]] || { echo "error: $ENV_FILE not found — run from the project root" >&2; exit 1; }
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

: "${RABBITMQ_MANAGEMENT_PORT:?}" "${RABBITMQ_USER:?}" "${RABBITMQ_PASSWORD:?}" "${RABBITMQ_VHOST:?}"
: "${RABBITMQ_NOTIFICATION_EXCHANGE:?}" "${RABBITMQ_NOTIFICATION_QUEUE:?}" "${RABBITMQ_NOTIFICATION_DLX:?}" "${RABBITMQ_NOTIFICATION_DLQ:?}"

API="http://localhost:${RABBITMQ_MANAGEMENT_PORT}/api"
# URL-encode the vhost. (Git Bash rewrites a bare "/" argument into a Windows path, so encode via stdin.)
VHOST="$(printf '%s' "$RABBITMQ_VHOST" | python -c "import urllib.parse,sys; print(urllib.parse.quote(sys.stdin.read(), safe=''))")"
auth=(-u "${RABBITMQ_USER}:${RABBITMQ_PASSWORD}")

api() { curl -s -o /dev/null -w "%{http_code}" "${auth[@]}" -H 'Content-Type: application/json' -X "$1" "$API/$2" ${3:+-d "$3"}; }

if [[ "${1:-}" == "--list" ]]; then
  echo "exchanges:"; curl -s "${auth[@]}" "$API/exchanges/$VHOST" | python -c "import sys,json; [print('  ', e['name'], e['type']) for e in json.load(sys.stdin) if e['name'] and not e['name'].startswith('amq.')]"
  echo "queues:";    curl -s "${auth[@]}" "$API/queues/$VHOST"    | python -c "import sys,json; [print('  ', q['name'], 'messages=' + str(q.get('messages', '?')), 'dlx=' + str(q.get('arguments',{}).get('x-dead-letter-exchange','-'))) for q in json.load(sys.stdin)]"
  echo "bindings:";  curl -s "${auth[@]}" "$API/bindings/$VHOST"  | python -c "import sys,json; [print('  ', b['source'], '--(' + b['routing_key'] + ')-->', b['destination']) for b in json.load(sys.stdin) if b['source']]"
  exit 0
fi

echo ">>> [rabbitmq] exchange ${RABBITMQ_NOTIFICATION_EXCHANGE} (topic)      HTTP $(api PUT "exchanges/$VHOST/${RABBITMQ_NOTIFICATION_EXCHANGE}" '{"type":"topic","durable":true}')"
echo ">>> [rabbitmq] exchange ${RABBITMQ_NOTIFICATION_DLX} (topic)  HTTP $(api PUT "exchanges/$VHOST/${RABBITMQ_NOTIFICATION_DLX}" '{"type":"topic","durable":true}')"
echo ">>> [rabbitmq] queue    ${RABBITMQ_NOTIFICATION_QUEUE}     HTTP $(api PUT "queues/$VHOST/${RABBITMQ_NOTIFICATION_QUEUE}" "{\"durable\":true,\"arguments\":{\"x-dead-letter-exchange\":\"${RABBITMQ_NOTIFICATION_DLX}\"}}")"
echo ">>> [rabbitmq] queue    ${RABBITMQ_NOTIFICATION_DLQ} HTTP $(api PUT "queues/$VHOST/${RABBITMQ_NOTIFICATION_DLQ}" '{"durable":true}')"
echo ">>> [rabbitmq] binding  ${RABBITMQ_NOTIFICATION_EXCHANGE} --(order.*)--> ${RABBITMQ_NOTIFICATION_QUEUE}   HTTP $(api POST "bindings/$VHOST/e/${RABBITMQ_NOTIFICATION_EXCHANGE}/q/${RABBITMQ_NOTIFICATION_QUEUE}" '{"routing_key":"order.*"}')"
echo ">>> [rabbitmq] binding  ${RABBITMQ_NOTIFICATION_DLX} --(#)--> ${RABBITMQ_NOTIFICATION_DLQ}   HTTP $(api POST "bindings/$VHOST/e/${RABBITMQ_NOTIFICATION_DLX}/q/${RABBITMQ_NOTIFICATION_DLQ}" '{"routing_key":"#"}')"
echo ">>> [rabbitmq] done (201 = created, 204 = already existed)"
