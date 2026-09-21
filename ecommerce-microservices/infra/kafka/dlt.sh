#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# OrderFlow — inspect and replay Kafka DEAD-LETTER TOPICS (Step 8)
#
# Each consumer parks records it gave up on (after retries) on its own DLT:
#   order-events.inventory.dlt   order-events.payment.dlt
#   payment-events.order.dlt     inventory-events.order.dlt
# Spring's DeadLetterPublishingRecoverer keeps the original key, value and
# headers (X-Request-Id, X-Event-Type, …) and adds kafka_dlt-original-topic,
# kafka_dlt-original-partition/offset, kafka_dlt-exception-fqcn/message.
#
#   bash infra/kafka/dlt.sh list  <dlt-topic>        show every parked record: key, why, original topic, headers, value
#   bash infra/kafka/dlt.sh replay <dlt-topic>       re-publish every parked record to its ORIGINAL topic (same key,
#                                                    original headers, kafka_dlt-* stripped) — the consumer's
#                                                    idempotency (processed_event / reservation status) makes a
#                                                    replay of something already applied a no-op
#   bash infra/kafka/dlt.sh count <dlt-topic>        records per partition
#
# Replay does NOT delete from the DLT (Kafka topics are logs); it is listed
# under a fresh consumer group each time, so run it once per incident. Run
# from the project root with the stack up; uses the broker container's tools.
# -----------------------------------------------------------------------------
set -Eeuo pipefail
[[ -f .env ]] || { echo "error: run from the project root" >&2; exit 1; }
set -a; . ./.env; set +a
CONTAINER="${KAFKA_CONTAINER:-orderflow-kafka}"
BOOTSTRAP="kafka:${KAFKA_INTERNAL_PORT:?}"
cmd="${1:-}"; topic="${2:-}"
[[ -n "$cmd" && -n "$topic" ]] || { sed -n 12,17p "$0"; exit 2; }
kx() { MSYS_NO_PATHCONV=1 docker exec -i "$CONTAINER" "$@"; }

# Dump: headers<TAB>key<TAB>value per record. Spring's kafka_dlt-exception-stacktrace header
# is multi-line, so records() re-joins continuation lines (stack frames) into one line per record
# with fields: KEEP_HEADERS<TAB>KEY<TAB>VALUE<TAB>WHY<TAB>ORIGINAL_TOPIC<TAB>REQUEST_ID<TAB>EVENT_TYPE
dump() {
  kx /opt/kafka/bin/kafka-console-consumer.sh --bootstrap-server "$BOOTSTRAP" --topic "$topic" --from-beginning --timeout-ms 5000 \
     --group "dlt-tool-$(date +%s)" --property print.headers=true --property print.key=true --property print.value=true \
     --property headers.separator=';' --property key.separator=$'\t' 2>/dev/null || true
}
records() {
  dump | awk '
    function hdr(name,   i, rest, j) { i = index(all, name ":"); if (i == 0) return ""; rest = substr(all, i + length(name) + 1); j = index(rest, ";"); if (j > 0) rest = substr(rest, 1, j - 1); sub(/\t.*/, "", rest); return rest }
    function flush(   n, f, value, key, keep, i) {
      if (rec == "") return;
      n = split(rec, f, "\t"); value = f[n]; key = f[n - 1]; all = rec;
      keep = f[1]; i = index(keep, ";kafka_dlt-"); if (i > 0) keep = substr(keep, 1, i - 1);
      cause = hdr("kafka_dlt-exception-cause-fqcn"); sub(/.*[.$]/, "", cause); why = hdr("kafka_dlt-exception-message"); sub(/.*; nested exception is /, "", why);
      printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\n", keep, key, value, (cause != "" ? cause " - " : "") why, hdr("kafka_dlt-original-topic"), hdr("X-Request-Id"), hdr("X-Event-Type");
      rec = "" }
    # a record starts with its first header (a letter); stack-trace lines start with TAB, "Caused by", "..." or ";"
    /^[A-Za-z]/ && $0 !~ /^(Caused by:|Suppressed:)/ { flush(); rec = $0; next }
    { rec = rec "\t" $0 }
    END { flush() }'
}

case "$cmd" in
  count)
    kx /opt/kafka/bin/kafka-get-offsets.sh --bootstrap-server "$BOOTSTRAP" --topic "$topic" 2>/dev/null | awk -F: '{ n += $3; printf "  partition %s: %s record(s)\n", $2, $3 } END { print "  total: " n+0 }'
    ;;
  list)
    records | awk -F'\t' '{ n++; printf "\n#%d  key=%s  eventType=%s  from=%s  requestId=%s\n   why: %.160s\n   value: %.220s\n", n, $2, $7, $5, $6, $4, $3 }
                          END { printf "\n%d dead-lettered record(s) on '"$topic"'\n", n }'
    ;;
  replay)
    tmp=$(mktemp); records > "$tmp"
    total=$(grep -c . "$tmp" || true)
    echo ">>> [dlt] $total record(s) on $topic"
    [[ "$total" -gt 0 ]] || { rm -f "$tmp"; exit 0; }
    for orig in $(awk -F'\t' '{ print $5 }' "$tmp" | sort -u); do
      [[ -n "$orig" ]] || continue
      count=$(awk -F'\t' -v o="$orig" '$5 == o' "$tmp" | wc -l)
      echo ">>> [dlt] replaying $count record(s) → $orig"
      # console-producer line format: headers<TAB>key<TAB>value (original headers kept, kafka_dlt-* dropped, X-Replayed-From added)
      awk -F'\t' -v o="$orig" -v t="$topic" '$5 == o { printf "%s;X-Replayed-From:%s\t%s\t%s\n", $1, t, $2, $3 }' "$tmp" \
      | kx /opt/kafka/bin/kafka-console-producer.sh --bootstrap-server "$BOOTSTRAP" --topic "$orig" \
           --property parse.headers=true --property parse.key=true --property headers.delimiter=$'\t' --property key.separator=$'\t' \
           --property headers.separator=';' --property headers.key.separator=':' >/dev/null
    done
    rm -f "$tmp"
    echo ">>> [dlt] done — the consumer's retries/idempotency decide what happens next; records stay on $topic (it is a log)"
    ;;
  *) sed -n 12,17p "$0"; exit 2 ;;
esac
