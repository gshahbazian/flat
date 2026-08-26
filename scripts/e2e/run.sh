#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"

if [[ -n "${FLAT_E2E_BIN:-}" ]]; then
  FLAT_BIN="$FLAT_E2E_BIN"
  if [[ ! -x "$FLAT_BIN" ]]; then
    printf 'E2E binary is not executable: %s\n' "$FLAT_BIN" >&2
    exit 1
  fi
  printf 'Using existing Flat CLI: %s\n' "$FLAT_BIN"
else
  printf 'Building Flat CLI...\n'
  cargo build --locked --bin flat --manifest-path "$REPO_ROOT/Cargo.toml"
  FLAT_BIN="$REPO_ROOT/target/debug/flat"
fi

scenarios=("$SCRIPT_DIR"/scenarios/*.sh)
if [[ ! -e "${scenarios[0]}" ]]; then
  printf 'No E2E scenarios found in %s\n' "$SCRIPT_DIR/scenarios" >&2
  exit 1
fi

for scenario in "${scenarios[@]}"; do
  printf '\nRunning %s\n' "$(basename "$scenario")"
  FLAT_E2E_BIN="$FLAT_BIN" FLAT_E2E_REPO_ROOT="$REPO_ROOT" bash "$scenario"
done

printf '\nAll E2E scenarios passed.\n'
