#!/usr/bin/env bash
set -euo pipefail

# Reset the local database: drop the volume, recreate Postgres+PostGIS, seed demo data.
docker compose down -v
docker compose up -d db

echo "Waiting for Postgres to accept connections ..."
until docker compose exec -T db pg_isready -U ridenow >/dev/null 2>&1; do
  sleep 1
done

docker compose exec -T db psql -U ridenow -d ridenow -c "CREATE EXTENSION IF NOT EXISTS postgis;"
npm run seed --workspace apps/api

echo "Database reset and seeded."
