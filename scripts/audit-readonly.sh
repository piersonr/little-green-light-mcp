#!/usr/bin/env bash
# Static guard: only name-updates.js and address-updates.js may write to LGL.
# Every other source file (recursively, excluding node_modules, test/, .git and
# .claude worktrees) must
#  1. not name a write HTTP method,
#  2. not call fetch() directly (lgl.js, GET-only, is the one exception), and
#  3. not import the raw write transports, which would skip the preview flow.
set -euo pipefail
cd "$(dirname "$0")/.."

writers='^\./(name-updates|address-updates)\.js$'
sources=()
while IFS= read -r file; do
  [[ "$file" =~ $writers ]] || sources+=("$file")
done < <(find . \( -name node_modules -o -name test -o -name .git -o -name .claude \) -prune -o \
  \( -name '*.js' -o -name '*.mjs' -o -name '*.cjs' \) -type f -print | sort)

failed=0
report() {
  if [ -n "$2" ]; then
    echo "FOUND $1:"
    echo "$2"
    failed=1
  fi
}

report "a write HTTP method outside the name/address-update modules" \
  "$(grep -nEi "[\"'](POST|PATCH|PUT|DELETE)[\"']" "${sources[@]}" || true)"

non_client=()
for file in "${sources[@]}"; do [ "$file" = "./lgl.js" ] || non_client+=("$file"); done
report "a direct fetch() outside lgl.js and the update modules" \
  "$(grep -nE "\bfetch[[:space:]]*\(" "${non_client[@]}" || true)"

report "an import of a raw write transport outside its own module" \
  "$(grep -nE "\b(patchConstituentName|postStreetAddress|patchStreetAddress)\b" "${sources[@]}" || true)"

if [ "$failed" -ne 0 ]; then exit 1; fi
echo "OK: writes are confined to name-updates.js and address-updates.js (${#sources[@]} other files checked)."
