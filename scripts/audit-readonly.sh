#!/usr/bin/env bash
# Mechanical guarantee that this server never issues a write request to LGL.
# Run before every change to index.js/lgl.js. Any match other than this
# script itself or a comment is a bug.
set -euo pipefail
cd "$(dirname "$0")/.."

hits=$(grep -rnE "method:\s*[\"'](POST|PATCH|PUT|DELETE)[\"']" --include="*.js" . \
  | grep -v node_modules || true)

if [ -n "$hits" ]; then
  echo "FOUND non-GET HTTP methods — this server must stay read-only:"
  echo "$hits"
  exit 1
fi

echo "OK: no POST/PATCH/PUT/DELETE method strings found outside node_modules."
