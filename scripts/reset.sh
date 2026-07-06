#!/usr/bin/env bash
set -euo pipefail

# Reset the local database: drop the volume, recreate Postgres+PostGIS, seed demo data.
docker compose down -v
docker compose up -d db

echo "Waiting for Postgres to accept connections ..."
attempt=0
until docker compose exec -T db pg_isready -U ridenow >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "Error: Postgres did not become ready after 30 attempts; aborting." >&2
    exit 1
  fi
  sleep 1
done

docker compose exec -T db psql -U ridenow -d ridenow -c "CREATE EXTENSION IF NOT EXISTS postgis;"

# Create the schema (rides table, etc.) before seeding. The `down -v` above wipes
# the volume, so the fresh database has no tables; Drizzle's db.insert() never
# issues DDL, so without this the seed fails with: relation "rides" does not exist.
npm run db:push --workspace apps/api
npm run seed --workspace apps/api

echo "Database reset and seeded."
