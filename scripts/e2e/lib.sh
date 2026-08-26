#!/usr/bin/env bash

# Shared lifecycle and assertion helpers for black-box E2E scenarios.

e2e_log() {
  printf '\n==> %s\n' "$*"
}

e2e_fail() {
  printf 'E2E failure: %s\n' "$*" >&2
  return 1
}

e2e_require_command() {
  command -v "$1" >/dev/null 2>&1 || e2e_fail "required command not found: $1"
}

e2e_assert_equal() {
  local expected="$1"
  local actual="$2"
  local description="$3"

  if [[ "$actual" != "$expected" ]]; then
    e2e_fail "$description: expected '$expected', got '$actual'"
  fi
}

e2e_assert_line() {
  local file="$1"
  local expected="$2"

  if ! grep -Fqx -- "$expected" "$file"; then
    e2e_fail "missing line '$expected' in $file"
  fi
}

e2e_make_workspace() {
  E2E_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/flat-e2e.XXXXXX")"
  E2E_SERVER_LOG="$E2E_TMP_DIR/server.log"
  E2E_SERVER_STATE="$E2E_TMP_DIR/server-state"
  mkdir -p "$E2E_SERVER_STATE"
}

e2e_pick_port() {
  node -e '
    const net = require("node:net")
    const server = net.createServer()
    server.listen(0, "127.0.0.1", () => {
      console.log(server.address().port)
      server.close()
    })
  '
}

e2e_start_server() {
  local ready_body
  local status

  E2E_SERVER_PORT="${FLAT_E2E_PORT:-$(e2e_pick_port)}"
  E2E_SERVER_URL="http://127.0.0.1:$E2E_SERVER_PORT"
  ready_body="$E2E_TMP_DIR/readiness.json"

  e2e_log "Starting Wrangler server at $E2E_SERVER_URL"
  (
    cd "$FLAT_E2E_REPO_ROOT/server"
    exec pnpm exec wrangler dev \
      --ip 127.0.0.1 \
      --port "$E2E_SERVER_PORT" \
      --persist-to "$E2E_SERVER_STATE" \
      --log-level error
  ) >"$E2E_SERVER_LOG" 2>&1 &
  E2E_SERVER_PID=$!

  for _ in {1..150}; do
    if ! kill -0 "$E2E_SERVER_PID" 2>/dev/null; then
      e2e_fail "Wrangler exited before becoming ready"
      return
    fi

    if ! status="$(
      curl --silent --show-error \
        --output "$ready_body" \
        --write-out '%{http_code}' \
        "$E2E_SERVER_URL/snapshot" 2>/dev/null
    )"; then
      sleep 0.2
      continue
    fi
    if [[ "$status" != "409" ]]; then
      sleep 0.2
      continue
    fi
    if ! jq -e '.error == "setup_required"' "$ready_body" >/dev/null; then
      sleep 0.2
      continue
    fi

    e2e_log "Server is ready"
    return
  done

  e2e_fail "Wrangler did not become ready within 30 seconds"
}

e2e_cleanup() {
  local status="$1"

  trap - EXIT INT TERM
  if [[ -n "${E2E_SERVER_PID:-}" ]] && kill -0 "$E2E_SERVER_PID" 2>/dev/null; then
    kill "$E2E_SERVER_PID" 2>/dev/null || true
    wait "$E2E_SERVER_PID" 2>/dev/null || true
  fi

  if [[ "$status" -ne 0 ]] && [[ -f "${E2E_SERVER_LOG:-}" ]]; then
    printf '\n--- Wrangler log ---\n' >&2
    sed -n '1,240p' "$E2E_SERVER_LOG" >&2
  fi

  if [[ "${FLAT_E2E_KEEP:-0}" == "1" ]]; then
    printf 'E2E artifacts preserved at %s\n' "$E2E_TMP_DIR"
  elif [[ -n "${E2E_TMP_DIR:-}" ]] && [[ -d "$E2E_TMP_DIR" ]]; then
    rm -rf -- "$E2E_TMP_DIR"
  fi

  exit "$status"
}
