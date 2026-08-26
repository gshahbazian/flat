#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib.sh"

: "${FLAT_E2E_BIN:?run this scenario through scripts/e2e/run.sh}"
: "${FLAT_E2E_REPO_ROOT:?run this scenario through scripts/e2e/run.sh}"

SETUP_CODE="flat_setup_CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk"
ADMIN_EMAIL="admin@example.com"
MEMBER_EMAIL="member@example.com"

E2E_SERVER_PID=""
E2E_TMP_DIR=""
trap 'e2e_cleanup "$?"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

e2e_require_command curl
e2e_require_command jq
e2e_require_command node
e2e_require_command pnpm

e2e_make_workspace
e2e_start_server

admin_root="$E2E_TMP_DIR/admin"
member_root="$E2E_TMP_DIR/member"

e2e_log "Creating tenant as the admin"
FLAT_DIR="$admin_root" FLAT_SETUP_CODE="$SETUP_CODE" "$FLAT_E2E_BIN" init \
  "$E2E_SERVER_URL" \
  --setup \
  --name e2e-admin-cli \
  --email "$ADMIN_EMAIL" \
  --tenant-name "Flat core E2E"
admin_path="$(FLAT_DIR="$admin_root" "$FLAT_E2E_BIN" path)"
admin_projects="$(FLAT_DIR="$admin_root" "$FLAT_E2E_BIN" project ls)"
jq -e 'any(.projects[]; .key == "DEMO")' <<<"$admin_projects" >/dev/null ||
  e2e_fail "admin snapshot did not contain the DEMO project"

e2e_log "Inviting and enrolling a member"
invitation_json="$(
  FLAT_DIR="$admin_root" "$FLAT_E2E_BIN" member invite "$MEMBER_EMAIL" --role member
)"
e2e_assert_equal "member" "$(jq -er '.role' <<<"$invitation_json")" "invitation role"
invitation_code="$(jq -er '.invitation_code' <<<"$invitation_json")"
[[ "$invitation_code" == flat_inv_* ]] || e2e_fail "CLI returned a malformed invitation code"

FLAT_DIR="$member_root" FLAT_INVITATION_CODE="$invitation_code" "$FLAT_E2E_BIN" init \
  "$E2E_SERVER_URL" \
  --invite \
  --name e2e-member-cli
member_path="$(FLAT_DIR="$member_root" "$FLAT_E2E_BIN" path)"
member_projects="$(FLAT_DIR="$member_root" "$FLAT_E2E_BIN" project ls)"
jq -e 'any(.projects[]; .key == "DEMO")' <<<"$member_projects" >/dev/null ||
  e2e_fail "member snapshot did not contain the DEMO project"

e2e_log "Creating a ticket as the admin"
created_output="$(
  FLAT_DIR="$admin_root" "$FLAT_E2E_BIN" new "Core E2E ticket" --project DEMO
)"
printf '%s\n' "$created_output"
ticket_key="$(awk 'NR == 1 { print $1 }' <<<"$created_output")"
e2e_assert_equal "DEMO-1" "$ticket_key" "first ticket key in a fresh tenant"

admin_ticket="$admin_path/DEMO/$ticket_key.md"
[[ -f "$admin_ticket" ]] || e2e_fail "admin ticket was not materialized at $admin_ticket"
e2e_assert_line "$admin_ticket" "title: Core E2E ticket"
e2e_assert_line "$admin_ticket" "status: todo"

e2e_log "Syncing and updating the ticket as the member"
FLAT_DIR="$member_root" "$FLAT_E2E_BIN" sync
member_ticket="$member_path/DEMO/$ticket_key.md"
[[ -f "$member_ticket" ]] || e2e_fail "member sync did not materialize $member_ticket"
e2e_assert_line "$member_ticket" "status: todo"

sed 's/^status: todo$/status: in_progress/' "$member_ticket" >"$member_ticket.updated"
mv "$member_ticket.updated" "$member_ticket"
e2e_assert_line "$member_ticket" "status: in_progress"
FLAT_DIR="$member_root" "$FLAT_E2E_BIN" push
FLAT_DIR="$admin_root" "$FLAT_E2E_BIN" sync
e2e_assert_line "$admin_ticket" "status: in_progress"

e2e_log "Commenting from the admin's dirty checkout"
sed 's/^title: Core E2E ticket$/title: Admin local title/' "$admin_ticket" >"$admin_ticket.updated"
mv "$admin_ticket.updated" "$admin_ticket"
printf 'Found the cause.\n\n- Added a regression test.\n' |
  FLAT_DIR="$admin_root" "$FLAT_E2E_BIN" comment "$ticket_key" --stdin
e2e_assert_line "$admin_ticket" "title: Admin local title"
e2e_assert_line "$admin_ticket" "status: in_progress"
e2e_assert_line "$admin_ticket" "<!-- flat:comments -->"
grep -Fq "### $ADMIN_EMAIL — " "$admin_ticket" ||
  e2e_fail "comment did not render admin attribution"
e2e_assert_line "$admin_ticket" "Found the cause."

e2e_log "Pushing the preserved local edit and converging mirrors"
FLAT_DIR="$admin_root" "$FLAT_E2E_BIN" push
FLAT_DIR="$member_root" "$FLAT_E2E_BIN" sync
if ! cmp -s "$member_ticket" "$admin_ticket"; then
  e2e_fail "admin and member mirrors did not converge"
fi

e2e_log "Core ticket flow passed"
