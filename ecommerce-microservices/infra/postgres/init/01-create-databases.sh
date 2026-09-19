#!/bin/bash
# Runs automatically on the FIRST start of the postgres container (empty data
# volume only). Creates one database + one owning user per Java service so no
# service can reach another service's tables.
set -euo pipefail

create_db_and_owner() {
  local db="$1" user="$2" password="$3"

  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-EOSQL
    DO \$\$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${user}') THEN
        CREATE ROLE "${user}" LOGIN PASSWORD '${password}';
      END IF;
    END
    \$\$;
EOSQL

  if ! psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres -tAc \
       "SELECT 1 FROM pg_database WHERE datname = '${db}'" | grep -q 1; then
    psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
      -c "CREATE DATABASE \"${db}\" OWNER \"${user}\";"
  fi

  # Lock the database down to its owner (revoke the default PUBLIC connect grant).
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-EOSQL
    REVOKE CONNECT ON DATABASE "${db}" FROM PUBLIC;
    GRANT ALL PRIVILEGES ON DATABASE "${db}" TO "${user}";
EOSQL

  echo "[init] database '${db}' owned by '${user}' is ready"
}

create_db_and_owner "$ORDER_DB_NAME"     "$ORDER_DB_USER"     "$ORDER_DB_PASSWORD"
create_db_and_owner "$INVENTORY_DB_NAME" "$INVENTORY_DB_USER" "$INVENTORY_DB_PASSWORD"
create_db_and_owner "$PAYMENT_DB_NAME"   "$PAYMENT_DB_USER"   "$PAYMENT_DB_PASSWORD"
