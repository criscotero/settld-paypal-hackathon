#!/bin/sh
# Checks SB-3 against the running docker-compose Postgres: each role can write its own schema
# and is denied on the other one and on `public`. Run: pnpm db:verify
set -eu

cd "$(dirname "$0")/.."
. ./.env

failures=0

run_as() {
  role=$1
  password=$2
  sql=$3
  docker compose exec -T -e PGPASSWORD="$password" postgres \
    psql -h 127.0.0.1 -U "$role" -d settld -v ON_ERROR_STOP=1 -qAt \
    -c "BEGIN; $sql; ROLLBACK;" >/dev/null 2>&1
}

expect_allowed() {
  if run_as "$1" "$2" "$3"; then
    echo "ok      $1: $3"
  else
    echo "FAIL    $1 should be allowed: $3"
    failures=$((failures + 1))
  fi
}

expect_denied() {
  if run_as "$1" "$2" "$3"; then
    echo "FAIL    $1 should be denied: $3"
    failures=$((failures + 1))
  else
    echo "ok      $1 denied: $3"
  fi
}

expect_allowed core_app "$CORE_APP_PASSWORD" "CREATE TABLE core.probe (id int)"
expect_denied core_app "$CORE_APP_PASSWORD" "CREATE TABLE engine.probe (id int)"
expect_denied core_app "$CORE_APP_PASSWORD" "CREATE TABLE public.probe (id int)"

expect_allowed engine_app "$ENGINE_APP_PASSWORD" "CREATE TABLE engine.probe (id int)"
expect_denied engine_app "$ENGINE_APP_PASSWORD" "CREATE TABLE core.probe (id int)"
expect_denied engine_app "$ENGINE_APP_PASSWORD" "CREATE TABLE public.probe (id int)"

# pg-boss (ADR-0007): Core API's jobs schema; the Engine has no access.
expect_allowed core_app "$CORE_APP_PASSWORD" "CREATE TABLE pgboss.probe (id int)"
expect_denied engine_app "$ENGINE_APP_PASSWORD" "CREATE TABLE pgboss.probe (id int)"

# Reads across schemas, against a table the admin creates and drops in the same transaction.
cross_read() {
  owner=$1
  reader=$2
  schema=$3
  docker compose exec -T postgres psql -U "$POSTGRES_ADMIN_USER" -d settld -v ON_ERROR_STOP=1 -qAt -c "
    BEGIN;
    SET LOCAL ROLE $owner;
    CREATE TABLE $schema.probe (id int);
    RESET ROLE;
    SET LOCAL ROLE $reader;
    SELECT * FROM $schema.probe;
    ROLLBACK;" >/dev/null 2>&1
}

# Positive controls: a denial above must come from grants, not from a broken probe.
for role_schema in "core_app core" "engine_app engine"; do
  set -- $role_schema
  if cross_read "$1" "$1" "$2"; then
    echo "ok      $1: SELECT FROM $2.*"
  else
    echo "FAIL    $1 should be allowed: SELECT FROM $2.*"
    failures=$((failures + 1))
  fi
done

if cross_read engine_app core_app engine; then
  echo "FAIL    core_app should be denied: SELECT FROM engine.*"
  failures=$((failures + 1))
else
  echo "ok      core_app denied: SELECT FROM engine.*"
fi

if cross_read core_app engine_app core; then
  echo "FAIL    engine_app should be denied: SELECT FROM core.*"
  failures=$((failures + 1))
else
  echo "ok      engine_app denied: SELECT FROM core.*"
fi

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "SB-3 role isolation holds"
