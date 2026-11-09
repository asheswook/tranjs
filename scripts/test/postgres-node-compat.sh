#!/usr/bin/env bash
set -euo pipefail

# Requires npm run build and a real PostgreSQL server (override with PG_URL).
# Examples:
#   bash scripts/test/postgres-node-compat.sh --all
#   bash scripts/test/postgres-node-compat.sh npx -y node@18
#   bash scripts/test/postgres-node-compat.sh node --no-experimental-require-module
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

run() {
    "$@" --unhandled-rejections=strict "$script_dir/postgres-node-compat.cjs"
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
