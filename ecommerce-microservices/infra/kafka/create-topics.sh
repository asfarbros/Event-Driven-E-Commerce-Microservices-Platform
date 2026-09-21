#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# OrderFlow — declare every Kafka topic the system needs (Step 4, made
# declarative + repeatable in Step 8)
#
# The broker runs with auto.create.topics.enable=false on purpose: a typo in a
# topic name must fail loudly, not silently create a topic with default
# settings. So every topic is created here, explicitly, from the names in .env.
#
# TWO WAYS TO RUN — same script, same result:
#   host   (Git Bash / WSL / Linux, from the PROJECT ROOT, stack up)
#            bash infra/kafka/create-topics.sh            # create/repair
#            bash infra/kafka/create-topics.sh --list     # describe
#          → sources .env and runs kafka-topics.sh INSIDE orderflow-kafka.
#   compose  the `kafka-init` service in infra/docker-compose.yml runs this
#            file inside the broker image (KAFKA_BIN is set) with the topic
#            names passed as environment; application services wait for it
#            with `depends_on: condition: service_completed_successfully`.
#
# IDEMPOTENT: `--create --if-not-exists` makes a re-run a no-op for existing
# topics, and the DLT retention is (re)applied with kafka-configs.sh --alter,
# so a topic that pre-dated this script gets the right config on the next run
# (before Step 8 the retention was only applied at creation time).
#
# TOPICS
#   order-events                Order → Inventory + Payment   (OrderCreated / OrderConfirmed / OrderCancelled)
#   inventory-events            Inventory → Order             (InventoryReserved / Confirmed / Released / ConfirmFailed / Restocked)
#   payment-events              Payment → Order               (PaymentSucceeded / PaymentFailed / PaymentRefunded)
#   order-events.inventory.dlt  records Inventory gave up on after retries
#   order-events.payment.dlt    records Payment gave up on after retries
#   payment-events.order.dlt    records Order gave up on after retries
#   inventory-events.order.dlt  records Order gave up on after retries
# Each consumer of a topic has its OWN dead-letter topic: a record Payment
# cannot process is not Inventory's problem, and vice versa. The full table
# (producers, consumer groups, replay) is in docs/messaging.md.
#
# PARTITIONS = KAFKA_TOPIC_PARTITIONS (3). Records are keyed by orderId, so all
#   events of one order share a partition and stay ordered; 3 partitions let a
#   consumer group scale to 3 instances later without a re-partition, and cost
#   nothing on one broker. DLTs get the same count so the dead-letter recoverer
#   can keep the source partition number (per-order ordering survives).
# REPLICATION = KAFKA_TOPIC_REPLICATION_FACTOR (1): there is exactly one broker
#   in the local stack; a factor > 1 cannot be satisfied and would fail.
# DLT RETENTION = 30 days: dead letters are for humans to inspect and replay,
#   so they outlive the default 7 days; the domain topics keep broker defaults.
# -----------------------------------------------------------------------------
set -eu

DLT_RETENTION_MS=$((30 * 24 * 60 * 60 * 1000))

if [ -n "${KAFKA_BIN:-}" ]; then
  # ---- inside the broker image (compose kafka-init): tools are local -------
  BOOTSTRAP="${KAFKA_BOOTSTRAP:?KAFKA_BOOTSTRAP is required (e.g. kafka:29092)}"
  kt() { "$KAFKA_BIN/kafka-topics.sh" --bootstrap-server "$BOOTSTRAP" "$@"; }
  kc() { "$KAFKA_BIN/kafka-configs.sh" --bootstrap-server "$BOOTSTRAP" "$@"; }
else
  # ---- on the host: source .env and exec inside the running container ------
  ENV_FILE="${ENV_FILE:-.env}"
  if [ ! -f "$ENV_FILE" ]; then
    echo "error: $ENV_FILE not found — run this from the project root (the folder that holds .env)" >&2
    exit 1
  fi
  case "$ENV_FILE" in */*) ;; *) ENV_FILE="./$ENV_FILE" ;; esac   # POSIX "." searches PATH for bare names
  set -a; . "$ENV_FILE"; set +a
  CONTAINER="${KAFKA_CONTAINER:-orderflow-kafka}"
  BOOTSTRAP="kafka:${KAFKA_INTERNAL_PORT:?KAFKA_INTERNAL_PORT is required}"
  kt() { MSYS_NO_PATHCONV=1 docker exec "$CONTAINER" /opt/kafka/bin/kafka-topics.sh --bootstrap-server "$BOOTSTRAP" "$@"; }
  kc() { MSYS_NO_PATHCONV=1 docker exec "$CONTAINER" /opt/kafka/bin/kafka-configs.sh --bootstrap-server "$BOOTSTRAP" "$@"; }
fi

: "${KAFKA_TOPIC_ORDER_EVENTS:?}" "${KAFKA_TOPIC_INVENTORY_EVENTS:?}" "${KAFKA_TOPIC_PAYMENT_EVENTS:?}"
: "${KAFKA_TOPIC_ORDER_EVENTS_INVENTORY_DLT:?}" "${KAFKA_TOPIC_ORDER_EVENTS_PAYMENT_DLT:?}"
: "${KAFKA_TOPIC_PAYMENT_EVENTS_ORDER_DLT:?}" "${KAFKA_TOPIC_INVENTORY_EVENTS_ORDER_DLT:?}"
PARTITIONS="${KAFKA_TOPIC_PARTITIONS:-3}"
REPLICATION="${KAFKA_TOPIC_REPLICATION_FACTOR:-1}"

DOMAIN_TOPICS="$KAFKA_TOPIC_ORDER_EVENTS $KAFKA_TOPIC_INVENTORY_EVENTS $KAFKA_TOPIC_PAYMENT_EVENTS"
DLT_TOPICS="$KAFKA_TOPIC_ORDER_EVENTS_INVENTORY_DLT $KAFKA_TOPIC_ORDER_EVENTS_PAYMENT_DLT $KAFKA_TOPIC_PAYMENT_EVENTS_ORDER_DLT $KAFKA_TOPIC_INVENTORY_EVENTS_ORDER_DLT"

if [ "${1:-}" = "--list" ]; then
  for t in $DOMAIN_TOPICS $DLT_TOPICS; do kt --describe --topic "$t" 2>/dev/null | grep "^Topic:" || echo "$t: MISSING"; done
  exit 0
fi

# Wait for the broker (compose starts kafka-init as soon as kafka is healthy;
# the API can still need a second or two).
n=0
until kt --list >/dev/null 2>&1; do
  n=$((n + 1)); [ "$n" -gt 30 ] && { echo "error: broker at $BOOTSTRAP not reachable" >&2; exit 1; }
  echo ">>> [kafka-topics] waiting for broker $BOOTSTRAP ($n)"; sleep 2
done

create() {
  echo ">>> [kafka-topics] ensuring topic '$1' (partitions=$PARTITIONS, replication=$REPLICATION)"
  kt --create --if-not-exists --topic "$1" --partitions "$PARTITIONS" --replication-factor "$REPLICATION"
}
for t in $DOMAIN_TOPICS $DLT_TOPICS; do create "$t"; done
for t in $DLT_TOPICS; do
  echo ">>> [kafka-topics] retention.ms=$DLT_RETENTION_MS on '$t'"
  kc --alter --entity-type topics --entity-name "$t" --add-config "retention.ms=$DLT_RETENTION_MS" >/dev/null
done

echo ">>> [kafka-topics] done:"
for t in $DOMAIN_TOPICS $DLT_TOPICS; do kt --describe --topic "$t" | grep "^Topic:"; done
