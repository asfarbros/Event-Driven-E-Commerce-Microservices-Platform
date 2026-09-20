#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Publish an order-events record by hand (stands in for Order Service until
# Step 6). Runs kafka-console-producer inside the broker container.
#
#   scripts/publish-order-event.sh OrderConfirmed ord-123 [request-id]
#   scripts/publish-order-event.sh OrderCancelled ord-123 [request-id]
#   scripts/publish-order-event.sh --raw ord-123 'this is not json'     # poison message
#
# The record key is the orderId (same partitioning rule Order Service will
# use) and the X-Request-Id header carries the correlation id, so the
# Inventory log lines and the inventory-events it publishes can be traced.
# Run from anywhere; needs docker and the orderflow-kafka container.
# -----------------------------------------------------------------------------
set -Eeuo pipefail

CONTAINER="${KAFKA_CONTAINER:-orderflow-kafka}"
BOOTSTRAP="${KAFKA_INTERNAL_BOOTSTRAP:-kafka:29092}"
TOPIC="${KAFKA_TOPIC_ORDER_EVENTS:-order-events}"

if [[ "${1:-}" == "--raw" ]]; then
  key="${2:?order id (record key) required}"
  value="${3:?raw value required}"
  request_id="${4:-manual-raw-$RANDOM}"
else
  event_type="${1:?event type required (OrderConfirmed | OrderCancelled)}"
  key="${2:?order id required}"
  request_id="${3:-manual-$RANDOM}"
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  value="{\"eventType\":\"${event_type}\",\"version\":1,\"eventId\":\"$(cat /proc/sys/kernel/random/uuid 2>/dev/null || echo "evt-$RANDOM-$RANDOM")\",\"orderId\":\"${key}\",\"occurredAt\":\"${now}\"}"
fi

# Line format: <headers>;<key>|<value>   (headers: name:value[,name:value])
printf 'X-Request-Id:%s;%s|%s\n' "$request_id" "$key" "$value" \
  | MSYS_NO_PATHCONV=1 docker exec -i "$CONTAINER" /opt/kafka/bin/kafka-console-producer.sh \
      --bootstrap-server "$BOOTSTRAP" --topic "$TOPIC" \
      --property parse.key=true --property key.separator='|' \
      --property parse.headers=true --property headers.delimiter=';' \
      --property headers.separator=',' --property headers.key.separator=':' \
      > /dev/null

echo "published to ${TOPIC}: key=${key} X-Request-Id=${request_id} value=${value}"
