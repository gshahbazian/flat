# flat

A ticket system with no UI, designed for AI agents: tickets sync down to plain
markdown files that agents grep, edit, and push back. See
[docs/001_initial_system.md](docs/001_initial_system.md) for the full design.

Current state: the second tracer bullet — concurrent edits. A push against a
stale base applies as long as it touches only fields the server hasn't
changed; a field both sides changed rejects the ticket whole, and
`flat sync --merge` three-way merges the server's changes into the edited
file, leaving git-style conflict markers where the edits overlap. One seeded
`DEMO` project, one bearer token.

## Layout

| Directory | What |
|---|---|
| `schema/` | Rust wire contract (source of truth) + JSON fixtures. `scripts/codegen.sh` generates `server/src/schema.gen.ts` via typeshare; CI round-trips every fixture in both languages |
| `server/` | TypeScript Cloudflare Worker + the single tenant Durable Object (SQLite tables + ordered mutation log) |
| `cli/` | The Rust `flat` CLI |
| `infra/` | Cloudflare infrastructure as code ([Alchemy](https://alchemy.run)) for real deployments |

## Quickstart (local)

```sh
# terminal 1: the server (token for local dev is in server/.dev.vars)
cd server && pnpm install && pnpm dev

# terminal 2: the CLI
cargo build
alias flat=target/debug/flat
flat init --server http://localhost:8787 --token dev-token
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
FLAT_TOKEN=<bearer token> ALCHEMY_PASSWORD=<state passphrase> pnpm deploy
```
