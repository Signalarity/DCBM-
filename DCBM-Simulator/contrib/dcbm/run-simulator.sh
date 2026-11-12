#!/usr/bin/env bash
# Rebuild the standalone report from cached public headers, or refresh explicitly.
set -euo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
args=()
if (( $# == 1 )) && [[ "$1" == --refresh ]]; then
    args+=(--refresh)
elif (( $# != 0 )); then
    printf 'Usage: %s [--refresh]\n' "$0" >&2
    exit 1
fi
exec python3 "$repo_dir/contrib/dcbm/simulator.py" \
    --output-dir "$repo_dir/build/dcbm-simulator" --open "${args[@]}"
