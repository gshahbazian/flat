# flat

A ticket system with no UI, designed for AI agents: tickets sync down to plain
markdown files that agents grep, edit, and push back. See
[docs/001_initial_system.md](docs/001_initial_system.md) for the full design.

Current implemented slice: projects and ownership, multi-project mirrors,
ticket priority, assignment, timestamps, per-member permissions for the HTTP
ticket-sync and administration surfaces, and GitHub PR webhooks. A deployment
is claimed once, admins invite members, and each installation or agent has a
distinct credential. The Durable Object enforces role, access, and token-kind
permissions. Signed GitHub pull-request webhooks can silently close tickets.

The broader accepted design is not complete yet. WebSocket/watch sessions,
search and remote MCP, comments, labels, force pushes, native
OS-keychain storage, and the operator-recovery deployment runbook remain
explicit follow-up work.

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
flat project create AUTH --name "Authentication"
flat new "Fix OAuth token refresh race" --project AUTH --priority high --assignee gabe@acme.com
$EDITOR "$(flat path)/AUTH/AUTH-1.md"     # edit fields or description body
flat push
flat sync
```

The mirror lives out-of-repo at `~/.flat/<host>/<PROJECT>/<PROJECT-N>.md`
(`FLAT_DIR` overrides the root, which is also the easy way to make a second
checkout).

## The file format

```markdown
---
id: DEMO-1
project: DEMO
title: Fix OAuth token refresh race
status: todo
priority: high
assignee: gabe@acme.com
created: 2026-08-25T12:34:56.000Z
updated: 2026-08-25T13:45:00.000Z
---

Description body.
```

Editable: `title`, `status` (`backlog|todo|in_progress|in_review|done|canceled`),
`priority` (`none|low|medium|high|urgent`), `assignee` (a member email or
`null`), and the body. Read-only: `id`, `project`, `created`, and `updated`.
`flat push`
diffs each file against its base copy and sends one atomic update mutation per
ticket; replaying a mutation is idempotent. Assignment emails are normalized
and resolved through the synced member cache; run `flat sync` when a member is
not found locally.

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
