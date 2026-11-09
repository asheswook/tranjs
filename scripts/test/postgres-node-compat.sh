#!/usr/bin/env bash
set -euo pipefail

# Requires npm install, npm run build and PostgreSQL (override with PG_URL).
# Each command tests both actual postgres.js majors, without replacing v4.
# Examples:
#   bash scripts/test/postgres-node-compat.sh --all
#   bash scripts/test/postgres-node-compat.sh npx -y node@18
#   bash scripts/test/postgres-node-compat.sh node --no-experimental-require-module
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

run() {
    POSTGRES_MAJOR=4 "$@" --unhandled-rejections=strict "$script_dir/postgres-node-compat.cjs"
    node "$script_dir/postgres-v3.cjs" --compat "$@"
}

if [[ "${1:-}" == "--all" ]]; then
    if [[ $# -ne 1 ]]; then
        echo "Usage: $0 [--all | node-command [node-args...]]" >&2
        exit 2
    fi
    run npx -y node@18
    run npx -y node@20.10.0
    run npx -y node@22 --no-experimental-require-module
elif [[ $# -eq 0 ]]; then
    run node
else
    run "$@"
fi
