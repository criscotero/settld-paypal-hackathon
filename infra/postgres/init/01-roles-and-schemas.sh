#!/bin/sh
# SB-3: each service reads and writes only its own schema.
# core_app owns `core`, engine_app owns `engine`, and neither has any grant on the other.
# The same layout is created in `settld` (development) and `settld_test` (integration tests),
# so tests can truncate tables without touching development data.
set -eu

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  -v core_password="$CORE_APP_PASSWORD" \
  -v engine_password="$ENGINE_APP_PASSWORD" <<'SQL'
CREATE ROLE core_app LOGIN PASSWORD :'core_password';
CREATE ROLE engine_app LOGIN PASSWORD :'engine_password';
CREATE DATABASE settld_test;
SQL

for db in "$POSTGRES_DB" settld_test; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" <<'SQL'
-- Nothing lands in `public` by accident.
REVOKE ALL ON SCHEMA public FROM PUBLIC;

CREATE SCHEMA core AUTHORIZATION core_app;
CREATE SCHEMA engine AUTHORIZATION engine_app;
-- pg-boss (Core API jobs and timers, ADR-0007). Its own schema so the library's generic
-- tables (job, queue, version) never mix with the domain; owned by core_app because job rows
-- are written in the same transaction as the state change (constitution IV). engine_app has
-- no grant on it (SB-3).
CREATE SCHEMA pgboss AUTHORIZATION core_app;
SQL
done

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
-- Role-level, so it applies in every database.
ALTER ROLE core_app SET search_path = core;
ALTER ROLE engine_app SET search_path = engine;
SQL
