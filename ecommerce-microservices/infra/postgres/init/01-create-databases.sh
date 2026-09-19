#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# OrderFlow — Postgres bootstrap
#
# Creates ONE database + ONE dedicated owner role for each Java service:
#   order_db     <- ORDER_DB_USER
#   inventory_db <- INVENTORY_DB_USER
#   payment_db   <- PAYMENT_DB_USER
#
# * Runs automatically by the official postgres image (docker-entrypoint-initdb.d)
#   ONLY on the first start against an EMPTY data volume. To re-run it:
#     docker compose --env-file .env -f infra/docker-compose.yml down -v
# * The superuser ($POSTGRES_USER) is used here and nowhere else.
# * Every value comes from the container environment (populated from root .env).
# * Data ownership is enforced, not just documented: CONNECT is revoked from
#   PUBLIC on each database, so a service's role cannot even open a session on
#   another service's database.
# -----------------------------------------------------------------------------
set -Eeo pipefail

# Fail fast with a clear message if any required variable is missing.
: "${ORDER_DB_NAME:?ORDER_DB_NAME is required}"
: "${ORDER_DB_USER:?ORDER_DB_USER is required}"
: "${ORDER_DB_PASSWORD:?ORDER_DB_PASSWORD is required}"
: "${INVENTORY_DB_NAME:?INVENTORY_DB_NAME is required}"
: "${INVENTORY_DB_USER:?INVENTORY_DB_USER is required}"
: "${INVENTORY_DB_PASSWORD:?INVENTORY_DB_PASSWORD is required}"
: "${PAYMENT_DB_NAME:?PAYMENT_DB_NAME is required}"
: "${PAYMENT_DB_USER:?PAYMENT_DB_USER is required}"
: "${PAYMENT_DB_PASSWORD:?PAYMENT_DB_PASSWORD is required}"

create_service_db() {
  local db_name="$1" db_user="$2" db_pass="$3"
  echo ">>> [orderflow-init] creating role '${db_user}' and database '${db_name}'"

  # Values are passed as psql variables (-v) and referenced as :"ident" / :'literal'
  # so they are quoted correctly and never interpolated by the shell.
  psql -v ON_ERROR_STOP=1 \
       -v db_name="${db_name}" -v db_user="${db_user}" -v db_pass="${db_pass}" \
       --username "${POSTGRES_USER}" --dbname "${POSTGRES_DB}" <<'EOSQL'
CREATE ROLE :"db_user" WITH LOGIN PASSWORD :'db_pass';
CREATE DATABASE :"db_name" WITH OWNER :"db_user";
-- Only the owning service may connect. (Superuser bypasses this, by design.)
REVOKE ALL ON DATABASE :"db_name" FROM PUBLIC;
GRANT ALL PRIVILEGES ON DATABASE :"db_name" TO :"db_user";
EOSQL
}

create_service_db "${ORDER_DB_NAME}"     "${ORDER_DB_USER}"     "${ORDER_DB_PASSWORD}"
create_service_db "${INVENTORY_DB_NAME}" "${INVENTORY_DB_USER}" "${INVENTORY_DB_PASSWORD}"
create_service_db "${PAYMENT_DB_NAME}"   "${PAYMENT_DB_USER}"   "${PAYMENT_DB_PASSWORD}"

echo ">>> [orderflow-init] done: ${ORDER_DB_NAME}, ${INVENTORY_DB_NAME}, ${PAYMENT_DB_NAME} ready"
