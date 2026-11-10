#!/bin/sh
# Drops and recreates the settld_demo database with the same layout as settld (SB-3), then
# migrates and seeds it with demo contracts (apps/api/src/db/seed-demo.cli.ts).
# Run: pnpm db:demo. Then start Core API against it: pnpm api:demo
set -eu

cd "$(dirname "$0")/.."
. ./.env

port=${POSTGRES_PORT:-5432}
admin() {
  docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$POSTGRES_ADMIN_USER" "$@"
}

# FORCE: a Core API still connected to the old database must not block the reset.
admin -d settld -qc "DROP DATABASE IF EXISTS settld_demo WITH (FORCE)"
admin -d settld -qc "CREATE DATABASE settld_demo"
admin -d settld_demo -q <<'SQL'
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA core AUTHORIZATION core_app;
CREATE SCHEMA engine AUTHORIZATION engine_app;
SQL

export CORE_DATABASE_URL="postgresql://core_app:${CORE_APP_PASSWORD}@127.0.0.1:${port}/settld_demo"
pnpm --silent --filter @settld/api build
node apps/api/dist/db/migrate.cli.js
node apps/api/dist/db/seed-demo.cli.js
