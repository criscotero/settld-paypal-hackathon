#!/bin/sh
# Runs the Engine's Procrastinate worker and starts it again whenever it stops. The worker exits
# when its database connection is lost; without this, one Postgres restart leaves every delivery
# stuck in VERIFYING until someone notices. Jobs survive in Postgres, so a restart loses nothing.
# Production gets this from its container scheduler. Run: pnpm engine:worker
cd "$(dirname "$0")/../apps/engine" || exit 1

child=""
# Ctrl-C and kill stop the loop too, not only the current worker.
trap '[ -n "$child" ] && kill "$child" 2>/dev/null; exit 0' INT TERM

while :; do
  "${UV:-uv}" run --env-file ../../.env procrastinate --app=settld_engine.tasks.app worker --queues=verification --concurrency=8 &
  child=$!
  wait "$child"
  echo "engine-worker: worker stopped with status $?; starting it again in 3 s" >&2
  sleep 3
done
