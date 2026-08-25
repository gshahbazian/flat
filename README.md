# flat

A ticket system with no UI, designed for AI agents: tickets sync down to plain
markdown files that agents grep, edit, and push back. See
[docs/001_initial_system.md](docs/001_initial_system.md) for the full design.

Current implemented slice: per-member permissions for the HTTP ticket-sync and
administration surfaces, plus GitHub PR webhooks. A deployment is claimed once,
admins invite members, each installation or agent has a distinct credential,
and the Durable Object enforces role, access, and token-kind permissions.
Signed GitHub pull-request webhooks can silently close tickets.

The broader accepted design is not complete yet. WebSocket/watch sessions,
search and remote MCP, comments, labels, projects, assignments, force pushes,
native OS-keychain storage, and the operator-recovery deployment runbook remain
explicit follow-up work.

## Layout

| Directory | What |
|---|---|
| `schema/` | Rust wire contract (source of truth) + JSON fixtures. `scripts/codegen.sh` generates `server/src/schema.gen.ts` via typeshare; CI round-trips every fixture in both languages |
| `server/` | TypeScript Cloudflare Worker + the single tenant Durable Object (SQLite tables + ordered mutation log) |
| `cli/` | The Rust `flat` CLI |
| `infra/` | Cloudflare infrastructure as code ([Alchemy](https://alchemy.run)) for real deployments |

## Quickstart (local)

```sh
# terminal 1: the server
cd server && pnpm install && pnpm dev

# terminal 2: the CLI
cargo build
alias flat=target/debug/flat
flat init http://localhost:8787 --setup
# local setup code: flat_setup_CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk
flat new "Fix OAuth token refresh race"   # -> DEMO-1  ~/.flat/localhost-8787/DEMO/DEMO-1.md
$EDITOR "$(flat path)/DEMO/DEMO-1.md"     # edit title, status, body
flat push
flat sync
```

The mirror lives out-of-repo at `~/.flat/<host>/DEMO/DEMO-N.md` (`FLAT_DIR`
overrides the root, which is also the easy way to make a second checkout).

## The file format

```markdown
---
id: DEMO-1
title: Fix OAuth token refresh race
status: todo
---

Description body.
```

Editable: `title`, `status` (`backlog|todo|in_progress|in_review|done|canceled`),
and the body. Read-only: `id`. `flat push` diffs each file against its base
copy and sends one atomic update mutation per ticket; replaying a mutation is
idempotent.

Conflicts are field-level: concurrent pushes that touch different fields of
the same ticket both apply, and a field both sides changed rejects the whole
ticket (the body merges line-wise, so only overlapping regions conflict).
`flat sync` never overwrites a file with local edits — it reports them and
withholds that ticket's delta; `flat sync --merge` merges the server's
changes in, writing `<<<<<<< local` / `>>>>>>> server` markers where the
edits collide. Edit the markers away and push again. To discard local edits
instead, delete the file: `flat sync` restores the last synced server state.

## Deploying

```sh
cd infra && pnpm install
ALCHEMY_PASSWORD=<state passphrase> pnpm deploy
```

Deployment generates and prints the one-time `flat_setup_...` credential. The
credential HMAC key and setup verifier are encrypted in Alchemy state; no
shared deployment-wide bearer token is installed.

After initialization, an admin can run `flat github` to print the exact
payload URL and tenant webhook secret. Configure a repository or organization
webhook for pull-request events with JSON content. The secret is tenant-wide:
every repository sharing it can close any ticket in that tenant, so group only
repositories with the same trust level. GitHub does not automatically retry a
failed delivery; redeliver it from delivery history. Flat stores a receipt by
delivery GUID, making redelivery idempotent.
