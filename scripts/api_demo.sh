#!/bin/sh
# Starts Core API in watch mode against settld_demo instead of settld (pnpm db:demo creates it).
# node --env-file never overrides a variable already set, so this URL wins over .env's.
set -eu
cd "$(dirname "$0")/.."
. ./.env
export CORE_DATABASE_URL="postgresql://core_app:${CORE_APP_PASSWORD}@127.0.0.1:${POSTGRES_PORT:-5432}/settld_demo"
exec pnpm --filter @settld/api dev
