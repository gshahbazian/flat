# Server-side MCP

Status: accepted design, planned and not implemented.

This document defines Flat's only Model Context Protocol implementation. It
extends the system design in `001_initial_system.md`, the authorization model
in `002_permissions_system.md`, the comment contract in `005_comments.md`, and
the search contract in `006_search.md`.

## Decision

Flat exposes one Cloudflare-hosted MCP endpoint:

```text
https://<flat-host>/mcp
```

It uses Streamable HTTP, Flat bearer tokens, and the TypeScript server. There
is no MCP command in the Rust CLI and no second MCP implementation on a client
machine.

Server-side MCP is the only design because:

1. The tenant Durable Object is already the authoritative data and
   authorization boundary.
2. Tools must read accepted server state, not a stale mirror or unpushed edits.
3. One HTTP endpoint works for hosted agents and local coding agents through
   the same protocol.
4. One implementation avoids duplicating tool definitions, validation,
   authentication, error handling, and write semantics in Rust and TypeScript.
5. It avoids managing a local process, MCP client command configuration, and
   process lifecycle.
6. Search already runs in the tenant Durable Object and can be reused directly.
7. The Markdown mirror and Rust CLI remain useful interfaces, but neither is
   part of MCP.
8. Tenant administration remains deliberately separate from agent work tools.

MCP reads and writes the tenant Durable Object directly. It never reads or
edits the Markdown mirror, invokes the Rust CLI, or sees unpushed local edits.
Conflict detection, authorization, attribution, and idempotency remain
server-enforced.

## Protocol and transport

The exact public path is `/mcp`. The Worker route allowlist recognizes only
`POST`, `GET`, `DELETE`, and `OPTIONS` on that exact path. A suffix such as
`/mcp/extra` is a 404. `POST` carries protocol messages. `OPTIONS` is an
unauthenticated CORS preflight that validates Origin and never reaches a tool;
the MCP HTTP handler serves it. Because Flat does not support server-pushed
messages or transport sessions, `GET` and `DELETE` return 405 with an `Allow`
header.

Implementation uses the Cloudflare Agents SDK v2 `createMcpHandler()` API from
`agents/mcp/server` and an SDK v2 server factory from
`@modelcontextprotocol/server`. Cloudflare recommends this handler for new
stateless servers, creates a fresh server per request, and explicitly supports
keeping durable application data behind a Durable Object. Configure it with:

```ts
{
  route: '/mcp',
  legacy: 'reject',
  responseMode: 'json',
}
```

The `legacy: 'reject'` option is intentional: Flat has no deployed MCP
contract to preserve. `responseMode: 'json'` is still the Streamable HTTP
protocol path, but it avoids holding an event stream open when every v1 tool
finishes in one request. Flat issues no MCP session ID and stores no protocol
session, event replay, subscription, or resume state. The tool list is static,
so it also advertises no list-changed capability. See Cloudflare's current
[MCP handler API](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/).

The endpoint exposes tools only. V1 has no MCP resources, prompts, sampling,
elicitation, roots, subscriptions, tasks, or server-originated notifications.

### Host, Origin, and CORS handling

The SDK handler validates any browser `Origin` and accepts origin-less
non-browser clients. Keep that validation enabled. Never configure
`allowedOriginHostnames: "*"`. The default localhost and `workers.dev`
allowlists are sufficient for the initial deployment. A deployment that adds
a custom hostname must configure exact `allowedHostnames` and, if it serves a
browser MCP client, exact `allowedOriginHostnames` at the same time. CORS does
not authenticate a caller.

All production traffic requires HTTPS. Bearer values are supplied as an
`Authorization` header, never in a URL. Cloudflare's MCP client supports
custom bearer headers for this use case; see the official
[McpClient header configuration](https://developers.cloudflare.com/agents/model-context-protocol/apis/client-api/#custom-headers).
OAuth discovery and interactive authorization are out of scope for the
self-hosted v1 product. Operators issue Flat human or agent tokens through the
existing CLI and configure that token in their MCP client.

## Routing and trust boundaries

The Worker owns the public MCP transport. The tenant Durable Object owns Flat
authentication, policy, validation against current data, reads, writes,
idempotency, and audit attribution.

```text
MCP client
  |  POST /mcp + Authorization: Bearer flat_pat_...
  v
Worker exact route + bounded protocol parser
  |  bearer-only authentication preflight
  v
Tenant Durable Object
  |  initialized? token valid? member active? key retained?
  v
Worker SDK tool dispatch
  |  typed tool input + unchanged Authorization header
  v
Tenant Durable Object tool executor
  |  reauthenticate -> authorize -> validate -> read/apply -> audit
  v
Worker MCP result adapter -> client
```

For every MCP HTTP request, before the SDK handles `initialize`, `tools/list`,
or `tools/call`, the Worker sends a bearer-only authentication probe to the
tenant Durable Object. The probe returns only success or the existing Flat
error; it does not return a principal that the Worker may trust later. This
ensures setup state, expiry, revocation, suspension, and verifier-key removal
also govern protocol discovery.

Each tool callback sends its validated input and the original, unchanged
`Authorization` value to a private, exact tenant-DO executor path. Those paths
are reachable through the Durable Object binding only and are not in the
Worker's public route allowlist. Private routing is defense in depth, not the
authorization boundary: the executor parses and verifies the bearer token
again, reloads the member and token rows, applies the policy action, and
performs the operation. It never trusts SDK `authInfo`, a Worker-built
principal, or identity-like tool arguments.

A write rechecks the principal inside its Durable Object transaction, using
the same `requireCurrentPrincipal` pattern as current administrative writes.
Revocation or suspension between the HTTP preflight and the transaction
therefore prevents the write.

The Worker must not forward the full MCP request body to a generic internal
HTTP API or let callers select a private path. Each registered tool calls one
typed executor function. Unknown tools stay MCP protocol errors.

## Authentication and credential lifecycle

The credential is the existing `flat_pat_<token-id>_<secret>` bearer token.
The tenant Durable Object follows the verification order in
`002_permissions_system.md`: parse, dummy-HMAC unknown IDs, constant-time
verification, revoked/expired checks, active-member check, principal
construction, then policy.

Tool callers cannot provide or override actor member ID, token ID, token kind,
agent name, delegating member, role, or access level. Any such property is
absent from every input schema, and strict schemas reject unknown properties.

Because the protocol is stateless, there are no active MCP sessions to close:

- Token expiry affects the next MCP HTTP request and is rechecked again at a
  tool transaction.
- Token revocation affects the next request; a request already in flight fails
  if revocation commits before its transactional principal check.
- Member suspension revokes the member's tokens in the existing transaction;
  subsequent and not-yet-committed MCP work fails with `invalid_token`.
- Removing an HMAC key makes every token tied to it invalid at the next probe
  or transaction check.
- Role demotion or token-access changes take effect at the next policy check.

No cached principal outlives an HTTP request. Successful initialization or
tool discovery never extends credential lifetime.

## Tool design

V1 exposes exactly seven tools:

| Tool | Purpose | Policy action | MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) |
|---|---|---|---|
| `search_tickets` | Search accepted ticket state | `work.search` | `true, false, true, false` |
| `get_ticket` | Read one full ticket and ordered comments | `work.read` | `true, false, true, false` |
| `list_projects` | Discover valid projects for ticket creation | `work.read` | `true, false, true, false` |
| `list_assignable_members` | Discover active members valid for assignment | `member.list` | `true, false, true, false` |
| `create_ticket` | Create a ticket in a named project | `ticket.create` | `false, false, true, false` |
| `update_ticket` | Update editable ticket fields with conflict detection | `ticket.update` | `false, true, true, false` |
| `add_comment` | Append a comment | `comment.create` | `false, false, true, false` |

All seven definitions are returned to every authenticated active member. Tool
descriptions state the required permission; invocation remains authoritative.
A viewer can discover the write tools but receives a normal authorization
error when calling one.

Project and member discovery are separate tools. Overloading ticket creation
with fuzzy project or assignee lookup would make writes ambiguous and harder
to retry. `list_projects` returns immutable keys and IDs; ticket creation then
accepts one exact project key. `list_assignable_members` returns active safe
profiles; create and update accept one exact normalized email or `null`. The
tenant Durable Object resolves both again inside the write transaction.

There is no general list-tickets tool. `search_tickets` already supports
filters-only queries and bounded pagination. There is no delete tool because
deletion requires an admin human token and is not part of the initial agent
surface.

Administrative tools are excluded. MCP cannot manage members, invitations,
recoveries, upgrades, tokens, audit records, setup, GitHub webhooks,
credentials, project ownership, or other tenant configuration. Those actions
continue through CLI commands and dedicated HTTP endpoints.

### Common tool-result conventions

Every tool declares strict JSON input and output schemas. Each output schema is
a union of that tool's success payload and the common error wrapper. A
successful call returns `structuredContent` conforming to the schema and one
short text block summarizing the outcome. The text block does not duplicate
ticket descriptions, comments, or full result JSON. The official MCP schema
requires tool-originated failures to use `isError: true`; see the
[MCP tool-result schema](https://modelcontextprotocol.io/specification/2025-11-25/schema#calltoolresult).

Timestamps are server-generated RFC 3339 UTC strings. IDs are immutable ULIDs.
Project keys and ticket keys are returned in their canonical uppercase form.
Emails are normalized. All objects reject unknown input fields.

Write results are receipts rather than mutable snapshots:

```json
{
  "key": "AUTH-142",
  "entity_id": "01K...",
  "seq": 4182,
  "replayed": false
}
```

`replayed` is `true` only when the server returned the stored result of the
same accepted write. A caller that needs the resulting ticket body calls
`get_ticket`. This keeps idempotent retries byte-for-byte stable even if the
entity changed after the original write.

### `search_tickets`

Description: search accepted server ticket state. Results do not include local
mirror edits, manually created files, or conflict markers. Results are
summaries; use `get_ticket` for the description and ordered comments.

Input is exactly the `SearchRequest` contract from `006_search.md`:

```json
{
  "query": "oauth project:AUTH status:todo,in_progress",
  "sort": "relevance",
  "limit": 20,
  "cursor": null
}
```

`query` is required. `sort`, `limit`, and `cursor` are optional. Defaults,
grammar, 4 KiB query limit, 50-clause limit, maximum page size 100, ranking,
excerpts, and cursor behavior are unchanged.

Output is exactly `SearchResponse`:

```json
{
  "results": [
    {
      "key": "AUTH-142",
      "title": "Fix OAuth token refresh race",
      "project": "AUTH",
      "status": "in_progress",
      "priority": "high",
      "assignee": "gabe@acme.com",
      "created_at": "2026-08-24T18:04:11.000Z",
      "updated_at": "2026-08-26T09:22:41.000Z",
      "match": {
        "source": "comment",
        "comment_id": "01K...",
        "excerpt": "...the refresh lock is per-process..."
      }
    }
  ],
  "next_cursor": null
}
```

The executor calls the existing `searchTickets()` implementation in the
tenant Durable Object. It does not call `POST /search` over the public network.

### `get_ticket`

Description: read a full ticket from accepted server state, including its
description and an ordered page of complete, untruncated comments. Local edits
are absent. Follow `next_comment_cursor` until null to read the comment history
that existed at the first page's `comment_watermark`.

Input:

```json
{
  "key": "AUTH-142",
  "comment_limit": 50,
  "comment_cursor": null
}
```

- `key` is required and is normalized to uppercase.
- `comment_limit` defaults to 50 and is limited to 1 through 100.
- `comment_cursor` is an opaque optional cursor. It binds the ticket ID, the
  first page's tenant sequence watermark, and the last returned comment
  `(seq,id)`. Reusing it with another key returns `invalid_cursor`.

Output:

```json
{
  "ticket": {
    "id": "01K...",
    "key": "AUTH-142",
    "project": { "id": "01J...", "key": "AUTH" },
    "title": "Fix OAuth token refresh race",
    "body": "Full Markdown description.",
    "status": "in_progress",
    "priority": "high",
    "assignee": { "id": "01H...", "email": "gabe@acme.com" },
    "created_at": "2026-08-24T18:04:11.000Z",
    "updated_at": "2026-08-26T09:22:41.000Z",
    "seq": 4180
  },
  "comments": [
    {
      "id": "01K...",
      "body": "Reproduced with two refreshes.",
      "author": {
        "kind": "agent",
        "member": { "id": "01H...", "email": "gabe@acme.com" },
        "agent_name": "ticket-triage",
        "delegated_by": null
      },
      "created_at": "2026-08-26T10:00:00.000Z",
      "seq": 4181
    }
  ],
  "comment_watermark": 4182,
  "next_comment_cursor": null
}
```

Human authors use `kind: "human"`, `agent_name: null`, and
`delegated_by: null`. `delegated_by`, when present, is a safe `{id,email}`
member reference. Suspended historical authors remain resolvable through safe
profiles. Token IDs and token records are not returned.

Comments sort by `seq`, then `id`. The first page captures the current tenant
sequence as `comment_watermark`; later pages include only comments at or below
that value, so concurrent appends do not make pagination endless. The full
ticket object appears on every page and reflects current accepted ticket state
at that page; comments are append-only and never truncated.

### `list_projects`

Description: discover exact project keys accepted by `create_ticket`. This
reads accepted server state and does not inspect project directories in a
mirror.

Input:

```json
{ "limit": 50, "cursor": null }
```

`limit` defaults to 50 and is limited to 1 through 100. `cursor` is an opaque
keyset cursor. Projects sort by key.

Output:

```json
{
  "projects": [
    {
      "id": "01J...",
      "key": "AUTH",
      "display_name": "Authentication",
      "description": "Login and session work"
    }
  ],
  "next_cursor": null
}
```

Owner lists are omitted because they are unnecessary for ticket creation.

### `list_assignable_members`

Description: discover active members whose email may be supplied as a ticket
assignee. It does not expose pending invitations, suspended members, tokens,
or enrollment data.

Input:

```json
{ "query": "gabe@", "limit": 50, "cursor": null }
```

`query` is an optional case-insensitive email substring of at most 256 UTF-8
bytes. `limit` defaults to 50 and is limited to 1 through 100. The cursor binds
the normalized query and last email. Results sort by email.

Output:

```json
{
  "members": [
    { "id": "01H...", "email": "gabe@acme.com", "role": "member" }
  ],
  "next_cursor": null
}
```

The executor reuses the safe member-profile projection and filters to active
members. The output is sufficient for exact assignment while withholding
administrative and credential state.

### `create_ticket`

Description: create a ticket directly in accepted server state. The project
key and assignee email must come from accepted server state, not a local
mirror. The caller must reuse `idempotency_key` when retrying an uncertain
result.

Input:

```json
{
  "idempotency_key": "agent-run-9f5d-create-auth-ticket",
  "project": "AUTH",
  "title": "Fix OAuth token refresh race",
  "body": "Observed under concurrent refresh.",
  "status": "todo",
  "priority": "high",
  "assignee": "gabe@acme.com"
}
```

- `idempotency_key` is required and matches
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`.
- `project` is a required project key and is normalized to uppercase.
- `title` uses the shared trimmed, nonempty, single-line title validation.
- `body` is optional and defaults to an empty string. It preserves Markdown
  verbatim and may not contain the comment sentinel.
- `status` and `priority` are optional and default to `todo` and `none`.
- `assignee` is optional. When present it is a normalized active-member email;
  `null` means unassigned.

The transaction resolves the project and assignee, generates the ticket ULID,
allocates the project's next key, applies the existing ticket-create mutation,
records idempotency and audit attribution, and returns the common write
receipt. Unknown projects and invalid assignees are validation errors.

### `update_ticket`

Description: update editable fields in accepted server state. `base_seq` must
come from `get_ticket`; it preserves Flat's field-level conflict semantics.
The tool does not merge against or modify a local working copy.

Input:

```json
{
  "idempotency_key": "agent-run-9f5d-update-auth-142",
  "key": "AUTH-142",
  "base_seq": 4180,
  "set": {
    "status": "in_review",
    "priority": "urgent",
    "assignee": null
  }
}
```

- `idempotency_key`, `key`, `base_seq`, and `set` are required.
- `base_seq` is an unsigned 32-bit sequence from the last full read.
- `set` is strict and must contain at least one of `title`, `body`, `status`,
  `priority`, or `assignee`.
- `assignee: null` clears assignment. Omitting `assignee` leaves it unchanged.
- Project, ID, timestamps, comments, actor data, and delegation are not
  editable fields.

The executor resolves the key and optional assignee in the write transaction,
then applies the existing ticket-update mutation. A stale `base_seq` may still
succeed when intervening writes changed only disjoint fields. Any overlapping
field rejects the entire tool call and returns the current ticket sequence in
the conflict detail, without returning current field values. The caller reads
again with `get_ticket`, reconciles intent, and uses a new idempotency key for
a changed request.

### `add_comment`

Description: append one comment directly to accepted server state. It never
edits the rendered comment suffix in a mirror. Attribution comes only from the
accepted bearer token.

Input:

```json
{
  "idempotency_key": "agent-run-9f5d-comment-auth-142",
  "key": "AUTH-142",
  "body": "Reproduced with two concurrent refreshes."
}
```

`idempotency_key` and `key` follow the rules above. `body` must contain
non-whitespace content and may contain at most 1 MiB of UTF-8. The executor
resolves the current ticket, captures server-derived human or agent
attribution, applies the existing append-only comment mutation, and returns a
receipt whose `key` is the parent ticket key and whose `entity_id` is the new
comment ULID.

## Shared contracts and server implementation

Reuse these existing contracts and helpers:

- `SearchRequest`, `SearchResponse`, `SearchResult`, `SearchMatch`, and
  `SearchSort` without an MCP copy.
- `Status`, `Priority`, role, member-status, and token enums.
- Project-key, email, title, ticket-body, comment-body, and sequence validators.
- The `Ticket`, `Comment`, `Project`, and `MemberProfile` storage projections
  as internal inputs to MCP-specific safe output adapters.
- `may()` and the stable action names in `policy.ts`.
- Bearer parsing, HMAC verification, canonical JSON hashing, principal
  construction, `apply()`, mutation logging, audit writing, and sequence
  allocation in the tenant Durable Object.

Do not parse the human-readable `MutationConflict.reason` string to build an
MCP error. Give the internal apply result a stable code and structured detail,
then let the sync adapter render its existing reason string while the MCP
adapter emits the error contract below.

Do not put MCP request and result types in the Rust source-of-truth schema when
the CLI and HTTP API do not consume them. Define those strict Zod/JSON Schema
contracts in a TypeScript MCP module. Search remains the exception because its
wire contract is already shared.

MCP adapters must not call public HTTP endpoints through `fetch()`. Extract or
reuse tenant-DO domain helpers so HTTP, sync, webhook, and MCP paths share one
implementation without a network loop. The tool layer translates human-facing
keys and emails into the existing ULID mutation contract only after current
server-state validation.

## Writes, retries, and conflicts

`create_ticket`, `update_ticket`, and `add_comment` require an explicit
idempotency key because an MCP client may retry after losing a response. The
server namespaces it as:

```text
mcp:<tool-name>:<idempotency_key>
```

The complete namespaced value is limited to 192 ASCII bytes. The server
reserves the `mcp:` mutation-ID namespace for this adapter.

Before applying a write, normalize defaulted values, uppercase keys, and
normalize email; hash the canonical object `{tool, input}`. Within the same
tenant-DO transaction as the write:

1. Reauthenticate and authorize the current principal.
2. Look up the namespaced ID in `applied_mutations`.
3. On a prior row, require the same effective member and input hash, then
   return the stored `AppliedMutation` receipt with `replayed: true`.
4. If the ID exists for another member, tool, or input hash, return
   `idempotency_key_reused` without revealing the original result.
5. Otherwise resolve server keys/emails, build an internal mutation with a new
   entity ULID where needed, apply it, store the member, accepted token, input
   hash, and original receipt, write the audit event, and commit together.

Authorization runs before a replay result is returned. A replacement token for
the same active member may replay the same request if the member still has the
required permission. Replays do not create another sequence or audit event.
An accepted comment replay preserves its original token attribution.

Transport or 5xx failures are safe to retry with the same idempotency key and
identical input. Validation, authorization, and conflict errors are not stored
as applied writes. A caller that changes any field must use a new key.

`update_ticket` preserves the existing atomic, field-level conflict rules. It
does not offer a force option. Conflict detection runs after authorization and
does not disclose field values to a caller that lacks permission.

## Error contract

Connection-level failures occur before MCP dispatch:

| Condition | HTTP behavior |
|---|---|
| Tenant uninitialized | `409` with `{ "error": "setup_required" }` |
| Missing, malformed, unknown, expired, revoked, key-removed token, or inactive member | `401` with `{ "error": "invalid_token" }` and `WWW-Authenticate: Bearer realm="flat"` |
| Body over the transport limit | `413` with `{ "error": "mcp_payload_too_large" }` |
| Unsupported media type | `415` with `{ "error": "unsupported_media_type" }` |
| Invalid Host or Origin | `403`, emitted before tool dispatch |

These responses apply to initialization and discovery as well as tool calls.
They never contain an MCP session ID.

Unknown methods and tools, malformed JSON-RPC, and arguments that fail a
tool's advertised structural JSON Schema remain SDK protocol errors (including
JSON-RPC `Invalid params`). Once a structurally valid registered-tool callback
begins, Flat domain and execution failures are MCP tool results with
`isError: true`, one safe text block, and this structured shape:

```json
{
  "error": {
    "category": "validation",
    "code": "invalid_assignee",
    "message": "Assignee must be an active member email.",
    "retryable": false,
    "details": { "field": "assignee" }
  }
}
```

The categories and mapping are:

| Flat condition | Category | Retryable | MCP code/detail |
|---|---|---:|---|
| Token becomes invalid after preflight | `authentication` | No | `invalid_token`; no credential detail |
| Current principal lacks the action | `authorization` | No | `forbidden` |
| Invalid Flat key, email, body, cursor, search query, or other domain value | `validation` | No | Stable specific code; search retains safe message and byte offset |
| Unknown ticket or project | `not_found` | No | `ticket_not_found` or `project_not_found` |
| Stale overlapping update | `conflict` | Yes, after reread | `ticket_conflict`, conflicting field names and current `seq`, no field values |
| Reused idempotency key with different member or input | `conflict` | No | `idempotency_key_reused`, no stored result |
| Unexpected Durable Object, SQLite, SDK, or serialization failure | `internal` | Yes | `internal_error` and a correlation ID only |

An authorization error takes precedence over validation and conflict details.
Internal errors are reported out of band with the same correlation ID but no
request arguments or result content. Do not expose stack traces, SQL, HMAC key
IDs, token IDs, credential state, or raw exception messages.

## Size limits and pagination

Limits are enforced while streaming request bytes, before JSON parsing where
possible:

| Item | Limit |
|---|---:|
| MCP HTTP request body | 2 MiB |
| Search query | 4 KiB and 50 clauses (existing contract) |
| Comment body | 1 MiB UTF-8 (existing contract) |
| Project/member/search page size | 100 rows |
| Comment page size | 100 comments |
| Serialized successful tool result | 4 MiB |
| Serialized error result | 16 KiB |

The request limit leaves JSON framing room around the largest accepted
comment. Tool inputs that include ticket descriptions are also bounded by the
2 MiB envelope. Search, project, member, and comment cursors are opaque and
parsed as untrusted data.

`get_ticket` never truncates a ticket body or comment. It packs complete
comments in sequence order up to both `comment_limit` and the 4 MiB result
limit, then returns a cursor. If the ticket object or one individual comment
cannot fit by itself, the call returns `result_too_large`; it does not emit
partial UTF-8 or partial Markdown. All content blocks and structured content
count toward the result limit.

V1 adds no application-level rate limiter. The single tenant Durable Object,
Cloudflare platform limits, strict body/result limits, bounded pages, and
credential entropy provide the initial abuse boundary. Record per-tool counts,
latency, error category, and response bytes so a later per-token or per-tenant
limit is based on observed traffic. Rate limiting remains an explicit
follow-up, not an implied guarantee.

## Audit and logging

Every first accepted write uses the existing audit action and the principal
derived from the bearer token:

- `create_ticket` records `ticket.create`.
- `update_ticket` records `ticket.update`.
- `add_comment` records `comment.create`.

Human tokens record the effective member and human token. Agent tokens record
the effective member, accepted token, agent name, and existing delegation
metadata. No fake system actor is created. Reads and searches remain unaudited,
matching current HTTP behavior. A replay creates no second audit event.

Audit metadata may contain the namespaced mutation ID, resulting sequence, and
target ID. It must not contain a ticket title, description, comment body,
search query, assignee argument, credential, authorization header, or complete
tool input.

Operational logs contain only:

- a server-generated correlation ID;
- HTTP method and route;
- MCP protocol method or registered tool name;
- response status or safe error category/code;
- duration and request/response byte counts.

Do not log authorization headers, bearer values, raw MCP bodies, tool
arguments, search text, ticket keys, titles, ticket bodies, comment bodies,
member query strings, result content, or raw exceptions. SDK `onerror` and
Durable Object error handlers log the correlation ID plus a fixed error class,
not the exception object. Cloudflare request logging and tracing configuration
must not capture bodies or sensitive headers.

## Deployment and configuration

Implementation changes remain inside the existing `server` Worker and tenant
Durable Object:

1. Add exact `/mcp` methods to `server/src/routing.ts`.
2. Add a TypeScript MCP transport/adapter module and private tenant-DO
   executors.
3. Add `agents` and the compatible exact
   `@modelcontextprotocol/server` v2 release to `server/package.json`; pin the
   versions selected together and commit the lockfile. Keep the existing Zod
   dependency.
4. Keep the existing `TENANT` binding and one `TenantDO`. Do not add another
   Durable Object, Worker, KV namespace, queue, or database.
5. Reuse `FLAT_HMAC_KEYS` and existing token rows. No MCP credential or shared
   secret is introduced.
6. Use the SDK's default localhost/`workers.dev` Host and Origin restrictions.
   A custom-domain deployment adds exact non-secret hostname/origin settings
   to both `server/wrangler.jsonc` and `infra/alchemy.run.ts`.
7. Verify the selected SDK's Worker compatibility-date requirement during
   implementation and move the Wrangler and Alchemy dates together if needed.

The current `applied_mutations` columns are sufficient for MCP write receipts;
no new persistence service is required. If implementation discovers that one
row cannot safely distinguish canonical MCP input from canonical sync
mutations, extend that table in the next numbered SQLite migration rather than
creating a second idempotency system.

The Rust CLI, `schema/src/lib.rs`, mirror store, and
`skills/flat/SKILL.md` gain no MCP command or behavior. The skill already
documents the CLI that exists today and therefore does not change for this
documentation-only decision.

## Tests

### Unit tests

- Every tool input accepts its documented shape and rejects unknown fields,
  identity fields, invalid enums, invalid sequences, oversized values, empty
  update sets, and malformed cursors.
- Every success and error conforms to its output schema and size bound.
- Tool descriptions explicitly say accepted server state, exclude local
  edits, and state the permission and retry requirement.
- MCP key/email normalization matches shared validators.
- Comment author adaptation covers human, agent, delegated agent, and
  suspended historical member attribution without token rows.
- Canonical idempotency hashing applies defaults and normalization before
  hashing.

### Routing and protocol tests

- Only exact allowed methods on `/mcp` reach the handler; suffixes and other
  methods fail as documented.
- `POST` initializes, lists exactly seven tools, and calls each tool through
  Streamable HTTP JSON responses.
- `GET` and `DELETE` return 405 and no session ID is ever returned.
- The handler rejects the legacy protocol lane.
- Oversized bodies, wrong content types, malformed JSON-RPC, invalid Host, and
  invalid Origin fail without invoking a tool.
- The endpoint never registers resources, prompts, tasks, subscriptions, or
  administrative tools.

### Authentication and permission tests

- Before setup, initialization, discovery, and calls return `setup_required`.
- Missing, malformed, unknown, expired, revoked, key-removed, suspended-member,
  and pending-member credentials fail through tenant-DO authentication.
- A direct private executor request without a valid bearer token fails.
- Admin, member, viewer, human, and agent principals receive the exact policy
  outcomes in the tool table.
- A viewer can search, read, and discover but cannot create, update, or
  comment.
- Revocation, expiry, suspension, demotion, and HMAC-key removal between
  preflight and transaction prevent the operation.
- Caller-supplied actor, token, agent, or delegation properties are rejected.

### Tenant integration tests

- Search results match `POST /search`, including qualifiers, ranking, excerpts,
  cursors, validation offsets, and immediate index visibility.
- Search and reads ignore an edited local mirror in the black-box scenario.
- `get_ticket` returns the full description and comments in stable order;
  comment pagination is fixed to its first-page watermark.
- Project discovery returns every project in key order and feeds a successful
  create.
- Member discovery returns only active safe profiles and feeds a successful
  assignment; suspension between discovery and write is rejected.
- Create allocates the correct project key and applies defaults.
- Update accepts disjoint stale writes, rejects overlapping stale writes
  atomically, clears an assignment with null, and cannot change read-only
  fields.
- Comment creation is append-only, searchable after commit, and retains exact
  human/agent/delegated attribution.
- Every accepted write records one mutation, sequence, idempotency receipt,
  and content-free audit event in one transaction.
- Same-member identical retry returns the original receipt; changed input or a
  different member returns `idempotency_key_reused`; replacement-token replay
  succeeds only while still authorized.
- Simulated failure rolls back entity, mutation log, receipt, and audit
  together.

### Black-box E2E

Extend the real Wrangler scenario to connect an MCP Inspector or SDK v2 test
client to `/mcp` with an admin token and a viewer token. It must discover the
seven tools, create a ticket after project/member discovery, search it, read it,
update it with `base_seq`, add and read a comment, replay each write, and prove
viewer writes fail. Edit the CLI mirror without pushing and prove MCP continues
to return accepted server state. Revoke the agent token and prove the next MCP
request fails.

The E2E test must use the deployed Worker URL and bearer header. It must not
invoke a client-side MCP process or use the Rust CLI as an MCP adapter.

## Implementation order

1. Pin the compatible Agents SDK and MCP SDK v2 packages; add a protocol-only
   `/mcp` handler with strict Host/Origin, body, method, and stateless settings.
2. Add the tenant-DO authentication preflight and private executor routing,
   with authentication and lifecycle tests before registering tools.
3. Add shared MCP result/error adapters, correlation IDs, safe logging, and
   output-size enforcement.
4. Implement `list_projects`, `list_assignable_members`, and `get_ticket`,
   including keyset cursors and comment watermarks.
5. Register `search_tickets` over the existing search request, response, and
   query engine.
6. Implement namespaced idempotency and `create_ticket` through the existing
   mutation, policy, attribution, and audit helpers.
7. Add `update_ticket` with required `base_seq` and field-level conflict tests.
8. Add `add_comment` with append-only validation and attribution tests.
9. Add routing, permission, integration, size, logging, and rollback tests.
10. Extend the black-box Wrangler E2E flow and update README status only after
    the implementation ships.

## Acceptance criteria

Server-side MCP is complete when:

- `/mcp` is the only MCP endpoint and exposes exactly the seven documented
  tools over stateless Streamable HTTP.
- The endpoint never issues a protocol session ID, and unsupported continued
  connection methods return 405.
- Every protocol request is authenticated by the tenant Durable Object and
  every tool is reauthenticated and policy-checked at execution.
- Token expiry, revocation, suspension, demotion, and HMAC-key removal take
  effect without cached-session delay.
- Reads and search return accepted server state only; unpushed mirror edits are
  invisible.
- Search reuses `006_search.md`, returns summaries, and pairs with a full
  ticket read containing ordered, untruncated comments.
- Project and assignable-member discovery make ticket creation deterministic
  without exposing administrative records.
- Writes reuse the server mutation, conflict, attribution, audit, and
  idempotency machinery and are safe to retry after a lost response.
- Callers cannot choose identity, token, agent, or delegation attribution.
- Every tool enforces its documented action and viewers cannot write.
- Administrative tools are absent.
- Request, result, pagination, logging, and error behavior meet this document.
- Unit, routing, permission, tenant integration, and real-Worker E2E tests pass.

## Explicitly out of scope

- Any second MCP implementation or client-side MCP process
- An MCP command in the Rust CLI
- Reading, writing, or reconciling the Markdown mirror through MCP
- Protocol sessions, SSE result streams, subscriptions, resumability, or tasks
- OAuth discovery or interactive OAuth flows
- Force updates, deletes, label tools, project administration, or project-owner
  changes
- Member, token, enrollment, recovery, setup, audit, webhook, credential, or
  tenant-administration tools
- Application-level rate limiting in v1

## Unresolved questions

There are no unresolved product or protocol questions for the v1 design. The
implementation must select mutually compatible exact SDK package versions and
confirm their minimum Worker compatibility date; those are dependency checks,
not changes to the architecture or tool contracts above.
