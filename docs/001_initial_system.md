# flat tee (codename)

An open source Linear clone with no UI: a backend service, an MCP server, and
a CLI (`flat`), designed primarily for AI agents. Tickets are still assigned
to real humans. Companies stand up their own instance and own their data.

Status: design complete (3 interview rounds). Ready for milestone sign-off.

`002_permissions_system.md` defines authentication, enrollment, roles, token
access, attribution, and project ownership. It supersedes the earlier details
in this document.

## Core thesis

Agents are bad at clicking UIs and great at grep. So the primary *read*
interface is the local filesystem: all tickets sync down to plain markdown
files that agents explore with `grep` / `cat` / `ls`, edit directly, and push
back. Structured writes also work via CLI commands and MCP tools.

## Settled decisions

| Decision | Answer |
|---|---|
| Name | Codename **flat tee**; CLI binary `flat`. Real name TBD |
| Server | TypeScript on Cloudflare Workers + Durable Objects |
| CLI | Rust |
| Schema sharing | Rust structs are source of truth; codegen TS types (typeshare / schemars -> JSON Schema); round-trip fixture tests in CI |
| Tenancy | One company = one deployment (single tenant). Sub-teams own **projects** |
| Hierarchy | Tenant -> projects -> tickets. No teams table in v1; members are tenant-level; projects list owner member IDs but remain visible to all members |
| Storage | One **tenant DO** (DO SQLite): all tables + one global ordered mutation log |
| Mirror | Out-of-repo: `~/.flat/<tenant-host>/` (`FLAT_DIR` overrides, `flat path` prints). Two-way editing, `flat push` |
| Filenames | Stable key-only: `AUTH-142.md` |
| Freshness | Explicit `flat sync` + `flat sync --watch` (WebSocket). No daemon in v1 |
| v1 entities | Projects, members, tickets, comments, labels |
| Deferred | Teams, milestones, cycles, ticket relations, attachments (R2), custom fields, custom statuses, OAuth, hosted multi-tenant service |
| Identity | Enrollment binds each token to a tenant member email. `git config user.email` may supply a CLI default or warning but grants no identity or access |
| Auth | One-time tenant setup, invitation enrollment, and per-installation human or agent bearer tokens. See `002_permissions_system.md` |
| MCP | One server-side MCP endpoint on the Worker, using Streamable HTTP and the existing per-member bearer tokens. See `007_server_mcp.md` |
| Hosting | Self-host only in v1: `wrangler deploy` into the company's own account |
| License | Apache-2.0 |
| Repo | Monorepo: `/server` (TS), `/cli` (Rust workspace), `/schema` (types + codegen), shared contract-test fixtures |

## Architecture

```
Cloudflare (company's own account)     Developer / agent machine
----------------------------------    --------------------------------------
Worker (HTTP API + /mcp)               flat CLI (Rust)
  └─ Tenant Durable Object               ├─ ~/.flat/<tenant>/AUTH/AUTH-142.md  <── agent reads/edits via bash
     (authoritative auth + data;        └─ base copies + SQLite state db
      SQLite projects, tickets,
      comments, labels, members,      flat sync / flat push
      FTS5 index, and one ordered            │
      mutation log)                         │
        ▲                                    │
        └── POST /sync (mutations up, ───────┘
            deltas down, one round trip)
```

Local coding agents and server-side hosted agents that can attach a Flat bearer
token connect to the same `/mcp` endpoint.

**Why one Durable Object:** the hard part of a ticket system is ordering, not
storage. A single DO serializes every write and stamps it with a
monotonically increasing `seq` transactionally — which also makes per-project
ticket counters (`AUTH-142`) trivial. One tenant DO = one log = one sync
stream. DO SQLite holds 10GB; tickets are text; shard only if that ever hurts.

Rejected: **D1** (build your own ordering, no WebSockets), **git as the
database** (concurrent agent writes = merge hell on structured data; we keep
the git-like *experience* via the file mirror instead).

## IDs and keys

- Every entity has an immutable **ULID**; the protocol speaks ULIDs.
- `AUTH-142` is a unique human-facing **key alias** — files, CLI, and humans
  see keys only. Keys let tickets later move projects (new key, old key kept
  as a redirect) without breaking identity.
- Project keys: `^[A-Z][A-Z0-9]{1,7}$`, chosen at creation, **immutable in
  v1** (display names rename freely). Ticket numbers: per-project counter
  from 1, never reused, never renumbered.
- Setup creates a default `DEMO` project so a new tenant has somewhere to put
  tickets before defining its own projects.

## Wire protocol (CLI <-> server)

The most fragile joint in the system: two languages, two deploy cycles.
Rust structs are the source of truth; TS types are generated; fixture tests
round-trip every message shape in CI.

### Mutation envelope

```json
{
  "mutation_id": "01JD...ULID",      // client-generated, idempotency key
  "op": "update",                    // create | update | delete
  "entity": "ticket",                // ticket | comment | project | label
  "entity_id": "01JC...ULID",
  "base_seq": 4021,                  // seq the client last saw for this entity
  "set": { "status": "in_progress", "assignee": "01JB...ULID" },
  "labels_add": ["auth"],
  "labels_remove": []
}
```

- Scalar fields: last-value `set`. List fields (labels): add/remove deltas,
  so concurrent taggers don't clobber each other.
- `assignee` travels as a member ULID. The CLI resolves the email in the file
  to a ULID from the synced members list before pushing; files keep emails.
- **Idempotency**: server keeps an `applied_mutations` table; a replayed
  `mutation_id` returns the original result instead of double-applying.
  Kept forever in v1. (Agents retry on every timeout — this is day-one
  behavior, not hardening.)
- Mutation IDs are otherwise opaque, but public `/sync` reserves the `mcp:`
  prefix for the server-side MCP adapter. A prefixed mutation is rejected on
  its own without blocking other valid mutations in the batch.

### Sync endpoint

One combined endpoint — every push also freshens the client:

```
POST /sync
  { "protocol_version": 2, "last_seq": 4021, "mutations": [ ... ] }
->
  { "applied": [...], "conflicts": [...], "deltas": [...], "latest_seq": 4090 }
```

- `protocol_version` handshake; server rejects mismatched versions.
- `flat sync --watch`: WebSocket to the DO (hibernation-friendly); frames
  reuse the delta format and may carry a watermark without entity data.
- Bootstrap: `GET /snapshot` — paginated JSON of all entities + the seq
  watermark it represents.
- Sequence numbers are cursors and may skip secret-only administrative
  mutations. Clients resync only after an explicit `resync_required`.
- **Compaction clause (encoded now, exercised never in v1):** the server may
  compact the mutation log below a floor; a client whose `last_seq` predates
  the floor receives `resync_required` and must take a fresh snapshot.

### Conflict semantics

- Conflict = a field the server changed since the mutation's `base_seq`.
- **Atomic per ticket**: all edits to one ticket travel as one mutation; if
  any field conflicts, nothing applies to that ticket. Other tickets in the
  same push still apply.
- Resolution: `flat sync --merge` rewrites the conflicted file to server
  state with the local unpushed values inline as git-style `<<<<<<<` conflict
  markers (frontmatter and body). Edit the markers away, push again. Agents
  already know how to resolve conflict markers.
- Description body: three-way text merge when both sides edited different
  regions; overlapping edits conflict as above.
- `flat push --force` skips conflict checks and applies local values.

## File format (the agent-facing API)

This format gets baked into AGENTS.md files and prompts we don't control —
it is *harder* to change than the wire protocol. Every editable field maps
1:1 to a mutation field.

```markdown
---
id: AUTH-142            # read-only (key alias)
title: Fix OAuth token refresh race
status: in_progress     # backlog|todo|in_progress|in_review|done|canceled
priority: high          # none|low|medium|high|urgent
assignee: gabe@acme.com # email or null
labels: [bug, auth]
project: AUTH           # read-only in v1
created: 2025-11-30T18:04:11Z   # read-only
updated: 2025-12-01T09:22:41Z   # read-only
---

Description body: everything between frontmatter and the sentinel. Freeform
markdown, three-way merged on push.

<!-- flat:comments -->
## Comments

### gabe@acme.com — 2025-11-30T18:40:02Z
Repro'd it, the refresh lock is per-process.

### claude (for gabe@acme.com) — 2025-11-30T19:02:11Z
Fix in PR #482.
```

- **Editable**: `title`, `status`, `priority`, `assignee`, `labels`, body.
- **Read-only**: `id`, `project`, `created`, `updated`, everything below the
  `<!-- flat:comments -->` sentinel. Edits below the sentinel (or a mangled
  sentinel) reject that ticket's push: "comments are read-only — use
  `flat comment AUTH-142`".
- **Reserved**: the exact `<!-- flat:comments -->` line cannot appear in the
  editable description body.
- `(for <email>)` in a comment heading renders server-derived agent
  attribution. Clients cannot submit the acting member.
- Comment bodies must contain non-whitespace content and are limited to 1 MiB
  of UTF-8.
- Priorities are **named strings**, not ints — self-documenting for agents.

## Enums

- Status: `backlog, todo, in_progress, in_review, done, canceled`
  (default `todo`). **Any-to-any transitions** in v1 — no workflow
  enforcement; validation hooks can come later.
- Priority: `none, low, medium, high, urgent` (default `none`).

## Mirror layout

```
~/.flat/acme/
  AUTH/
    AUTH-142.md
    AUTH-143.md
  BILL/
    BILL-7.md
  .flat/                # base copies, SQLite state db, last synced seq
```

Users point agents at it with one line in AGENTS.md: "tickets live at
`flat path`; run `flat sync` first."

## CLI v1 surface

```
flat init                      # connect to tenant, write config, first snapshot
flat sync [--watch] [--merge]
flat push [KEY ...] [--force]  # default: all dirty files
flat new TITLE --project AUTH [--assignee me] [...]
flat comment KEY [TEXT|--stdin]
flat set KEY field=value ...   # generic setter (no assign/close sugar)
flat ls / flat show KEY        # pretty listings over local cache
flat search QUERY              # server FTS
flat path                      # print mirror location
flat project|member|token ...  # admin subcommands
```

One generic `flat set` instead of sugar commands — fewer commands for agents
to learn; file editing is the primary write path anyway.

## Search

Server-side **SQLite FTS5** in the tenant DO over title/description/comments
(one virtual table + triggers on rows we already write). Exposed as the
`search_tickets` MCP tool — required by hosted agents that cannot grep — and
`flat search` for parity. Local agents are taught to grep the mirror first.

## MCP

Flat has one MCP implementation: a Cloudflare-hosted Streamable HTTP endpoint
at `/mcp`. It uses the same bearer credentials as the HTTP API, and the tenant
Durable Object authenticates, authorizes, and executes every tool operation.
MCP reads accepted server state directly; it never reads or edits the Markdown
mirror, invokes the Rust CLI, or sees unpushed local edits.

One implementation is the natural fit because the tenant Durable Object is
already the authoritative data and authorization boundary and search already
runs there. The same endpoint serves local coding agents and server-side hosted
agents that can attach a Flat bearer token, without duplicating tool
definitions, validation, authentication, error handling, or write semantics in
Rust and TypeScript. It also avoids a local process, client configuration, and
lifecycle. It does not serve browser pages or OAuth widget flows. The Markdown
mirror and Rust CLI remain useful, separate interfaces.

The initial tools search and read tickets, create and update tickets, append
comments, list projects, and discover active assignable members. Membership,
token, enrollment, audit, webhook, credential, and other tenant administration
remain CLI and dedicated-HTTP responsibilities. `007_server_mcp.md` defines
the exact protocol, contracts, security behavior, and tool list.

## First milestone

Exercises every architectural bet before MCP enters the picture:

1. `/schema`: entity + mutation structs in Rust, TS codegen, fixture tests.
2. Worker + tenant DO: `/sync`, `/snapshot`, mutation log, idempotency.
3. CLI: `init`, `new`, `sync` (mirror materialization), `push` with
   field-level conflict detection and `--merge` markers.

Then: comments, `--watch`, FTS + `search`, server-side MCP, admin commands,
docs + example AGENTS.md snippet.

Auth in the first milestone is one shared bearer token checked in the Worker
— a placeholder. The real system in `002_permissions_system.md` is its own
milestone and replaces that placeholder.
