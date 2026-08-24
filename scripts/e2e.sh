#!/usr/bin/env bash
# End-to-end test of the first milestone: schema -> server -> CLI.
#
# Boots `wrangler dev` with a fresh local DO, then drives two mirrors
# (simulating two machines) through init, project add, new, edit/push,
# concurrent non-overlapping edits (field-level merge on the server),
# overlapping edits (conflict -> `flat sync --merge` markers -> resolve ->
# push), comments, read-only enforcement, idempotent replay, and the
# protocol-version handshake.
#
# Usage: scripts/e2e.sh [PORT]
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${1:-8799}"
URL="http://127.0.0.1:$PORT"
TOKEN=dev-token
WORK=$(mktemp -d /tmp/flat-e2e.XXXXXX)
A="$WORK/mirror-a"
B="$WORK/mirror-b"
LOG="$WORK/wrangler.log"

fail() { echo "FAIL: $*" >&2; exit 1; }

cargo build -q -p flat-cli
FLAT="$PWD/target/debug/flat"
a() { FLAT_DIR="$A" "$FLAT" "$@"; }
b() { FLAT_DIR="$B" "$FLAT" "$@"; }

# --- server: fresh local state every run ------------------------------------
rm -rf server/.wrangler/state
[ -f server/.dev.vars ] || cp server/.dev.vars.example server/.dev.vars
(cd server && CI=true npx wrangler dev --port "$PORT" >"$LOG" 2>&1) &
WRANGLER_PID=$!
cleanup() {
  kill "$WRANGLER_PID" 2>/dev/null || true
  sleep 1
  pkill -f "workerd.*$PORT" 2>/dev/null || true
}
trap cleanup EXIT

for i in $(seq 1 60); do
  if curl -sf -H "Authorization: Bearer $TOKEN" "$URL/" >/dev/null 2>&1; then break; fi
  [ "$i" = 60 ] && { cat "$LOG"; fail "wrangler dev did not come up"; }
  sleep 1
done
echo "server ready on $URL"

# --- bootstrap two mirrors ----------------------------------------------------
a init --server "$URL" --token "$TOKEN" --dir "$A"
b init --server "$URL" --token "$TOKEN" --dir "$B"
python3 - "$A" tester-a@example.com <<'EOF'
import json, sys
p = sys.argv[1] + "/.flat/config.json"
c = json.load(open(p)); c["email"] = sys.argv[2]; json.dump(c, open(p, "w"))
EOF

a project add AUTH --name "Authentication" --owner gabe@acme.com
a new "Fix OAuth token refresh race" --project AUTH --assignee gabe@acme.com \
  --priority high --label auth --label bug -m "The refresh lock is per-process."
[ -f "$A/AUTH/AUTH-1.md" ] || fail "AUTH-1.md not materialized"
grep -q '^priority: high' "$A/AUTH/AUTH-1.md" || fail "priority missing"

b sync
[ -f "$B/AUTH/AUTH-1.md" ] || fail "AUTH-1.md did not sync to mirror B"

# --- basic edit + push --------------------------------------------------------
perl -pi -e 's/^status: todo$/status: in_progress/' "$A/AUTH/AUTH-1.md"
a push
grep -q '^status: in_progress' "$A/AUTH/AUTH-1.md" || fail "status not canonicalized after push"

# --- concurrent edits to different fields both apply (no conflict) ------------
# B has not seen A's status change; it edits priority. Field-level detection
# must let this through.
perl -pi -e 's/^priority: high$/priority: urgent/' "$B/AUTH/AUTH-1.md"
b push || fail "non-overlapping concurrent edit was rejected"
grep -q '^status: in_progress' "$B/AUTH/AUTH-1.md" || fail "B did not pick up server status"
grep -q '^priority: urgent' "$B/AUTH/AUTH-1.md" || fail "B lost its priority edit"

# --- overlapping edits conflict, then merge with markers ----------------------
a sync
perl -pi -e 's/^title: .*/title: Fix OAuth refresh race (A wording)/' "$A/AUTH/AUTH-1.md"
a push
perl -pi -e 's/^title: .*/title: Fix OAuth refresh race (B wording)/' "$B/AUTH/AUTH-1.md"
if b push 2>/dev/null; then fail "overlapping title edit should conflict"; fi
b sync --merge
grep -q '<<<<<<< local' "$B/AUTH/AUTH-1.md" || fail "merge did not write conflict markers"
if b push 2>/dev/null; then fail "push with unresolved markers should fail"; fi
# resolve: keep the local wording
python3 - "$B/AUTH/AUTH-1.md" <<'EOF'
import re, sys
p = sys.argv[1]; t = open(p).read()
t = re.sub(r"<<<<<<< local\n(.*?)\n=======\n.*?\n>>>>>>> server\n", r"\1\n", t, flags=re.S)
open(p, "w").write(t)
EOF
b push || fail "push after resolving markers failed"
a sync
grep -q 'title: Fix OAuth refresh race (B wording)' "$A/AUTH/AUTH-1.md" || fail "resolved title did not propagate"

# --- comments: write via CLI, read-only in the file ----------------------------
a comment AUTH-1 "Repro'd it, the refresh lock is per-process."
grep -q "Repro'd it" "$A/AUTH/AUTH-1.md" || fail "comment not rendered"
b sync
grep -q "Repro'd it" "$B/AUTH/AUTH-1.md" || fail "comment did not sync to B"
printf '\n### mallory@evil.com \xe2\x80\x94 2025-01-01T00:00:00Z\nforged\n' >> "$B/AUTH/AUTH-1.md"
if b push 2>/dev/null; then fail "editing below the comments sentinel should reject the push"; fi
b push 2>&1 | grep -q 'comments are read-only' || true
cp "$B/.flat/base/AUTH-1.md" "$B/AUTH/AUTH-1.md"   # undo

# --- read-only frontmatter ------------------------------------------------------
perl -pi -e 's/^created: .*/created: 1999-01-01T00:00:00Z/' "$B/AUTH/AUTH-1.md"
if b push 2>/dev/null; then fail "editing created should reject the push"; fi
cp "$B/.flat/base/AUTH-1.md" "$B/AUTH/AUTH-1.md"   # undo

# --- push --force overrides a conflict ------------------------------------------
b sync
perl -pi -e 's/^title: .*/title: Fix OAuth refresh race (A again)/' "$A/AUTH/AUTH-1.md"
a push
perl -pi -e 's/^title: .*/title: Fix OAuth refresh race (B force)/' "$B/AUTH/AUTH-1.md"
b push --force || fail "push --force failed"
a sync
grep -q '(B force)' "$A/AUTH/AUTH-1.md" || fail "forced title did not win"

# --- idempotency: replaying a mutation_id returns the original result -----------
PAYLOAD='{"protocol_version":1,"last_seq":0,"mutations":[{"mutation_id":"01JD0AAAAAAAAAAAAAAAAAAAAA","op":"create","entity":"project","entity_id":"01JD0BBBBBBBBBBBBBBBBBBBBB","base_seq":0,"set":{"key":"IDEM","name":"Idempotency"},"labels_add":[],"labels_remove":[]}]}'
R1=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$PAYLOAD" "$URL/sync")
R2=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$PAYLOAD" "$URL/sync")
SNAP=$(curl -s -H "Authorization: Bearer $TOKEN" "$URL/snapshot")
python3 - "$R1" "$R2" "$SNAP" <<'EOF'
import json, sys
r1, r2, snap = (json.loads(x) for x in sys.argv[1:4])
assert r1["applied"][0]["seq"] == r2["applied"][0]["seq"], "replay returned a different seq"
assert r1["applied"][0]["key"] == "IDEM"
assert sum(1 for p in snap["projects"] if p["key"] == "IDEM") == 1, "replay double-applied"
EOF

# --- protocol version handshake ---------------------------------------------------
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"protocol_version":0,"last_seq":0,"mutations":[]}' "$URL/sync")
[ "$CODE" = 400 ] || fail "protocol_version 0 should be rejected, got $CODE"

# --- auth ---------------------------------------------------------------------------
CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer wrong" "$URL/snapshot")
[ "$CODE" = 401 ] || fail "bad token should 401, got $CODE"

echo
echo "e2e: all checks passed"
