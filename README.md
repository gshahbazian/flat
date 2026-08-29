# flat

A ticket system with no UI, designed for AI agents: tickets sync down to plain
markdown files that agents grep, edit, and push back. See
[docs/001_initial_system.md](docs/001_initial_system.md) for the full design.

Current implemented slice: projects and ownership, multi-project mirrors,
ticket fields and labels, append-only comments, server-side search with a CLI client,
server-side MCP, per-member permissions for the HTTP ticket-sync and
administration surfaces, and GitHub PR webhooks. Comments retain server-derived
human or agent attribution and render directly in ticket files. A deployment
is claimed once, admins invite members, and each installation or agent has a
distinct credential.
Operator recovery provides a deployer-only break-glass path for an existing
active admin without resetting the tenant.

The broader accepted design is not complete yet. Force pushes and native
OS-keychain storage remain explicit follow-up work.

## MCP

Process MCP clients connect to `https://<flat-host>/mcp` with a Flat human or
agent bearer token in the `Authorization` header. The stateless endpoint
exposes ticket search and reads, project and assignee discovery, ticket create
and update (including labels), and comment creation. It always reads accepted server state, so
unpushed Markdown mirror edits are intentionally absent.

## Layout

| Directory | What |
|---|---|
| `schema/` | Rust wire contract (source of truth) + JSON fixtures. `scripts/codegen.sh` generates `server/src/schema.gen.ts` via typeshare; CI round-trips every fixture in both languages |
| `server/` | TypeScript Cloudflare Worker + the single tenant Durable Object (SQLite tables + ordered mutation log) |
| `cli/` | The Rust `flat` CLI |
| `infra/` | Cloudflare infrastructure as code ([Alchemy](https://alchemy.run)) for real deployments |

## Install the agent skill

Install the `flat` skill globally with
[Vercel's Skills CLI](https://www.skills.sh/):

```sh
npx skills add gshahbazian/flat --skill flat --global
```

## Quickstart (local)

```sh
# terminal 1: the server
cd server && pnpm install && pnpm dev

# terminal 2: the CLI
cargo build
alias flat=target/debug/flat
flat init http://localhost:8787 --setup
# local setup code: flat_setup_CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk
# setup creates a default DEMO project
flat project create AUTH --name "Authentication"
flat label create auth
flat new "Fix OAuth token refresh race" --project AUTH --priority high --assignee gabe@acme.com --label auth
flat comment AUTH-1 "Reproduced with two concurrent refreshes."
$EDITOR "$(flat path)/AUTH/AUTH-1.md"     # edit fields or description body
flat push
flat sync
```

The mirror lives out-of-repo at `~/.flat/<host>/<PROJECT>/<PROJECT-N>.md`
(`FLAT_DIR` overrides the root, which is also the easy way to make a second
checkout).

## End-to-end verification

The black-box E2E suite builds the CLI, starts a real local Wrangler server,
and drives separate admin and member checkouts through the core ticket flow:

```sh
pnpm install
pnpm e2e
```

Set `FLAT_E2E_KEEP=1` to preserve the temporary server log, Durable Object
state, and CLI mirrors for debugging a run.

## The file format

```markdown
---
id: DEMO-1
project: DEMO
title: Fix OAuth token refresh race
status: todo
priority: high
assignee: gabe@acme.com
labels: [auth, bug]
created: 2026-08-25T12:34:56.000Z
updated: 2026-08-25T13:45:00.000Z
---

Description body.

<!-- flat:comments -->
## Comments

### ticket-triage (for gabe@acme.com) — 2026-08-25T14:10:00.000Z
Reproduced with two concurrent refreshes.
```

Editable: `title`, `status` (`backlog|todo|in_progress|in_review|done|canceled`),
`priority` (`none|low|medium|high|urgent`), `assignee` (a member email or
`null`), `labels` (a sorted inline list of synced label names), and the body.
Read-only: `id`, `project`, `created`, `updated`, and
everything from the `<!-- flat:comments -->` sentinel onward. Add comments
with `flat comment KEY TEXT` or pipe multiline Markdown to `flat comment KEY
--stdin`. Comments must contain non-whitespace content and may be at most 1 MiB
of UTF-8. The exact sentinel line is reserved and cannot appear in a ticket
description. If a mutation is pending, run `flat sync` before adding another
comment. Comments-only syncs replace the read-only suffix while preserving
local edits above it. CRLF conversion and final newlines do not count as
comment edits. `flat push` diffs each file against its base copy and sends one
atomic update mutation per ticket; replaying a mutation is idempotent.
Assignment emails are normalized and resolved through the synced member cache;
run `flat sync` when a member is not found locally.
Label names use lowercase ASCII slugs. Manage them with `flat label` and search
accepted state with qualifiers such as `label:bug` or `label:none`.

Conflicts are field-level: concurrent pushes that touch different fields of
the same ticket both apply, and a field both sides changed rejects the whole
ticket (the body merges line-wise, so only overlapping regions conflict).
`flat sync` never overwrites editable fields with local changes. A comments-only
delta updates the read-only suffix directly; an editable server change is
withheld until `flat sync --merge` merges it, writing `<<<<<<< local` /
`>>>>>>> server` markers where edits collide. Edit the markers away and push
again. To discard local edits instead, delete the file: `flat sync` restores
the last synced server state.

## Deploying

```sh
cd infra && pnpm install
pnpm exec alchemy configure   # first time: OAuth + account
ALCHEMY_PASSWORD='<state-passphrase>' pnpm run deploy
```

Deployment generates and prints the one-time `flat_setup_...` credential. The
credential HMAC key and setup verifier are encrypted in Alchemy state; no
shared deployment-wide bearer token is installed.

### Operator recovery

If every admin has lost access, use the same Alchemy state, Cloudflare account,
stage, and profile as the normal deployment:

```sh
cd infra
ALCHEMY_PASSWORD='<state-passphrase>' pnpm recover -- --stage prod
```

Omit `--stage prod` if the deployment uses Alchemy's default stage. Add
`--profile <profile>` when the normal deployment uses one. The command prompts
for the Flat server URL and active admin email. It generates a one-time
operator credential, deploys only its HMAC verifier, calls the recovery
endpoint, prints the 15-minute recovery code once, and deploys again with the
operator verifier removed. Neither credential is accepted as a command-line
argument.

If the final cleanup deployment fails, immediately rerun the normal deployment
with the same stage and profile. A successfully used verifier remains consumed
in the tenant even while stale Worker configuration is present.

Redeem the printed recovery code through the existing CLI flow; the CLI prompts
for it instead of accepting it in argv:

```sh
flat init https://<flat-host> --recover
```

After initialization, an admin can run `flat github` to print the exact
payload URL and tenant webhook secret. Configure a repository or organization
webhook for pull-request events with JSON content. The secret is tenant-wide:
every repository sharing it can close any ticket in that tenant, so group only
repositories with the same trust level. GitHub does not automatically retry a
failed delivery; redeliver it from delivery history. Flat stores a receipt by
delivery GUID, making redelivery idempotent.
