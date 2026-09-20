#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# OrderFlow — create the Kafka topics (Step 4)
#
# The broker runs with auto.create.topics.enable=false on purpose: a typo in a
# topic name must fail loudly, not silently create a new topic with default
# settings. So every topic is created here, explicitly, from the names in .env.
#
# Run from the PROJECT ROOT (the folder that holds .env), with the stack up:
#
#   bash infra/kafka/create-topics.sh            # create what is missing
#   bash infra/kafka/create-topics.sh --list     # just describe the topics
#
# Idempotent: --if-not-exists makes re-runs a no-op. Works from Git Bash /
# WSL / Linux: it only needs `docker`. Commands run INSIDE the broker
# container over the INTERNAL listener (kafka:29092).
#
# Topics created now (Inventory needs all three):
#   order-events                Order → Inventory (OrderConfirmed / OrderCancelled) [Order publishes in Step 6]
#   inventory-events            Inventory → Order (InventoryReserved / Confirmed / Released / ConfirmFailed)
#   order-events.inventory.dlt  dead letters: order-events records Inventory gave up on after retries
# payment-events is added in Step 5 (Payment Service) — add one line below.
#
# Partitions (KAFKA_TOPIC_PARTITIONS, default 3):
#   Records are keyed by orderId, so every event about one order lands on the
#   same partition and is consumed in order. Three partitions cost nothing on
#   one broker and let a consumer group scale to three instances later
#   without repartitioning. The DLT gets the SAME count because the
#   dead-letter publisher copies a record to the same partition NUMBER it
#   came from, preserving per-order ordering in the DLT too.
# Replication (KAFKA_TOPIC_REPLICATION_FACTOR, must be 1 here):
#   one broker → one replica. On a real cluster set 3 and min.insync.replicas=2.
# Retention:
#   event topics keep the broker default (7 days). The DLT keeps records for
#   30 days so a poisoned message can be inspected and replayed by a human.
# -----------------------------------------------------------------------------
set -Eeuo pipefail

ENV_FILE="${ENV_FILE:-.env}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: $ENV_FILE not found — run this from the project root (the folder that holds .env)" >&2
  exit 1
fi
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

: "${KAFKA_TOPIC_ORDER_EVENTS:?KAFKA_TOPIC_ORDER_EVENTS is required}"
: "${KAFKA_TOPIC_INVENTORY_EVENTS:?KAFKA_TOPIC_INVENTORY_EVENTS is required}"
: "${KAFKA_TOPIC_ORDER_EVENTS_INVENTORY_DLT:?KAFKA_TOPIC_ORDER_EVENTS_INVENTORY_DLT is required}"
: "${KAFKA_INTERNAL_PORT:?KAFKA_INTERNAL_PORT is required}"
PARTITIONS="${KAFKA_TOPIC_PARTITIONS:-3}"
REPLICATION="${KAFKA_TOPIC_REPLICATION_FACTOR:-1}"
CONTAINER="${KAFKA_CONTAINER:-orderflow-kafka}"
BOOTSTRAP="kafka:${KAFKA_INTERNAL_PORT}"
DLT_RETENTION_MS=$((30 * 24 * 60 * 60 * 1000))

# MSYS_NO_PATHCONV stops Git Bash from mangling /opt/kafka/... into a Windows path.
kt() { MSYS_NO_PATHCONV=1 docker exec "$CONTAINER" /opt/kafka/bin/kafka-topics.sh --bootstrap-server "$BOOTSTRAP" "$@"; }

if [[ "${1:-}" == "--list" ]]; then
  kt --describe --topic "$KAFKA_TOPIC_ORDER_EVENTS" --topic "$KAFKA_TOPIC_INVENTORY_EVENTS" --topic "$KAFKA_TOPIC_ORDER_EVENTS_INVENTORY_DLT" 2>/dev/null \
    || kt --list
  exit 0
fi

create() {
  local topic="$1"; shift
  echo ">>> [kafka-topics] ensuring topic '${topic}' (partitions=${PARTITIONS}, replication=${REPLICATION})"
  kt --create --if-not-exists --topic "$topic" --partitions "$PARTITIONS" --replication-factor "$REPLICATION" "$@"
}

create "$KAFKA_TOPIC_ORDER_EVENTS"
create "$KAFKA_TOPIC_INVENTORY_EVENTS"
create "$KAFKA_TOPIC_ORDER_EVENTS_INVENTORY_DLT" --config "retention.ms=${DLT_RETENTION_MS}"

echo ">>> [kafka-topics] done. Current topics:"
kt --list
