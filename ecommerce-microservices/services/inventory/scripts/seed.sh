#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Seed inventory rows for every product in Catalog. Run explicitly, never on boot.
#
#   scripts/seed.sh              insert rows that are missing; leave existing ones untouched
#   scripts/seed.sh --update     also reset existing rows' `available` to the seed quantity
#
# Needs: PostgreSQL up (inventory_db), Catalog running on CATALOG_SERVICE_URL,
# root .env in place. Builds the jar if it is missing. Runs the service with the
# "seed" profile: no HTTP server, no Kafka consumer, no sweeper — just the
# seed/SeedRunner, then exit.
# -----------------------------------------------------------------------------
set -Eeuo pipefail
cd "$(dirname "$0")/.."

JAR=target/inventory-service.jar
if [[ ! -f "$JAR" ]]; then
  echo ">>> [seed] building $JAR"
  ./mvnw -q -B -DskipTests package
fi

exec java -jar "$JAR" --spring.profiles.active=seed "$@"
