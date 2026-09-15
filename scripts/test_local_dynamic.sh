#!/usr/bin/env bash
# Offline regression suite only. No service, Docker, browser, or paid inference.
# Installed Pi/guarded-launcher integration tests use fake transport exclusively.
set -euo pipefail
cd "$(dirname "$0")/.."
# Do not inherit deployment settings, lease endpoints, or provider credentials.
# App imports also initialize SQLite: keep that away from any application data.
test_data="$(mktemp -d "${TMPDIR:-/tmp}/cvent-offline-suite.XXXXXX")"
trap 'rm -rf "$test_data"' EXIT
env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" \
  CVENT_ENV=development CVENT_DATA_ROOT="$test_data" PYTHONPATH=.:tests \
  python3 -m unittest discover -s tests
node --check ego_direct.mjs
node --check scripts/run_pi_guarded.mjs
node --check scripts/benchmark_client.mjs
node --check scripts/model_request_guard.mjs
git diff --check
