#!/usr/bin/env bash
# The lookup client and MCP registration layer must not issue write HTTP
# requests. name-updates.js is the sole, separately tested PATCH transport.
set -euo pipefail
cd "$(dirname "$0")/.."

sources=()
for source in ./*.js; do
  if [ "$source" != "./name-updates.js" ]; then
    sources+=("$source")
  fi
done
hits=$(grep -nEi "method:[[:space:]]*[\"'](POST|PATCH|PUT|DELETE)[\"']" \
  "${sources[@]}" || true)

if [ -n "$hits" ]; then
  echo "FOUND a write HTTP method outside the isolated name-update transport:"
  echo "$hits"
  exit 1
fi

echo "OK: no HTTP write method found outside the isolated name-update transport."
