# flat tee (codename)

An open source Linear clone with no UI: a backend service and a CLI (`flat`),
designed primarily for AI agents. Tickets sync down to plain markdown files
that agents explore with `grep` / `cat` / `ls`, edit directly, and push back.

See [TICKET_SYSTEM.md](TICKET_SYSTEM.md) for the full design. This repo
currently implements the **first milestone**:

- `/schema` — Rust structs are the source of truth for the wire protocol;
  JSON Schemas and TypeScript types are generated from them; shared fixtures
  are round-tripped by both languages in CI
- `/server` — TypeScript on Cloudflare Workers; one tenant Durable Object
  (SQLite) holds all tables plus one global ordered mutation log, and serves
  `POST /sync` and `GET /snapshot` with idempotent mutations and field-level
  conflict detection
- `/cli` — Rust `flat` binary: `init`, `sync` (mirror materialization,
  `--merge` writes git-style conflict markers), `push` (`--force`), `new`,
  `comment`, `ls`, `path`, `project add|ls`

Still to come (in design order): `sync --watch`, FTS + `flat search`,
local MCP (`flat mcp`), remote MCP, member/token admin commands.

## Repo layout

```
schema/    Rust protocol crate + codegen bin + shared fixtures + json schemas
server/    Cloudflare Worker + Tenant Durable Object (TypeScript)
cli/       the `flat` binary (Rust)
scripts/   e2e.sh — full integration test against `wrangler dev`
```

## Develop

```sh
# Rust: protocol round-trip tests + CLI unit tests
cargo test

# server: contract tests + typecheck
cd server && npm install && npm test && npm run check

# regenerate schema/json + server/src/schema.ts after editing schema/src/lib.rs
cd server && npm run codegen

# full end-to-end (boots wrangler dev on a scratch port)
scripts/e2e.sh
```

## Run it

Server (self-host, your own Cloudflare account):

```sh
cd server
npx wrangler deploy
npx wrangler secret put ADMIN_TOKEN   # emit/keep your admin token
```

Local dev server instead: `cp .dev.vars.example .dev.vars && npm run dev`.

CLI:

```sh
cargo build -p flat-cli --release     # binary at target/release/flat

flat init --server https://flat-server.<you>.workers.dev --token <ADMIN_TOKEN>
flat project add AUTH --name "Authentication"
flat new "Fix OAuth token refresh race" --project AUTH --assignee me --priority high
flat path                             # mirror lives at ~/.flat/<tenant-host>

$EDITOR "$(flat path)/AUTH/AUTH-1.md" # edit title/status/priority/assignee/labels/body
flat push                             # push all dirty files
flat sync                             # pull server changes
flat sync --merge                     # fold server changes into dirty files
flat comment AUTH-1 "repro'd"         # comments are read-only in the file
```

Point agents at it with one line in AGENTS.md: “tickets live at `flat path`;
run `flat sync` first.”

## Notes / deviations from the design doc

- The CLI's local state is JSON (`.flat/state.json`) rather than a SQLite db;
  it is internal and swappable, and tickets-as-text keeps it small.
- Auth in this milestone is the single `ADMIN_TOKEN` secret; the `members` /
  per-agent token tables arrive with the admin commands.
- `GET /snapshot` carries the pagination cursor in the contract but always
  returns one page for now.
