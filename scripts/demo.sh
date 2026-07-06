#!/usr/bin/env bash
set -euo pipefail

# Watch the core loop: poll the API health endpoint until it returns 200.
API_URL="${API_URL:-http://localhost:3000}"

echo "Polling ${API_URL}/health ..."
for _ in $(seq 1 30); do
  if curl -fsS "${API_URL}/health"; then
    echo ""
    echo "API is healthy."
    exit 0
  fi
  sleep 2
done

echo "API did not become healthy in time." >&2
exit 1
