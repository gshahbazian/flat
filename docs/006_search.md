# Server search

Status: implemented for the server, HTTP API, and CLI. MCP transport support
remains deferred until those transports ship.

This document defines server search for Flat. It extends the search outline in
`001_initial_system.md` and uses the authorization model in
`002_permissions_system.md`.

## Goals

Search gives a human or agent a compact list of tickets that match text and
structured ticket fields. It reads accepted server state. It does not inspect
the local Markdown mirror, unpushed edits, manually created files, or conflict
markers.

Local agents may search the mirror with `rg` when they want local working-copy
state. Flat does not wrap, replace, or synchronize that workflow.

The complete feature has four callers:

- `flat search` in the Rust CLI.
- The local MCP server.
- The remote MCP server.
- The HTTP API used by those clients.

The HTTP contract, result model, and query behavior are shared. The first
implementation phase ships the index, HTTP API, and CLI. MCP uses the same
contract when those transports ship.

## Settled decisions

| Decision | Answer |
|---|---|
| Source of truth | Accepted state in the tenant Durable Object |
| Execution | Server-side only |
| Engine | SQLite FTS5 in the tenant Durable Object |
| Result unit | One result per ticket |
| Entities | Tickets only |
| Full-text fields | Ticket title, ticket description body, comment bodies |
| Metadata | Structured filters, not full-text fields |
| Exact lookup | A ticket key is recognized without a qualifier |
| Query syntax | A small Flat-owned language inspired by GitHub issue search |
| Consistency | Index updates commit in the same transaction as source writes |
| Default order | Relevance, then most recently updated, then ticket key |
| Authorization | Existing `work.search` policy action; all active tenant roles with read access |

Search includes tickets in every status by default. `done` and `canceled`
tickets are not hidden.

## Query language

The public language is not SQLite FTS5 syntax. The server parses the query into
an FTS expression and parameterized SQL predicates. Callers cannot select FTS
columns, invoke FTS functions, or submit raw `MATCH` expressions.

Examples:

```text
oauth refresh
"token refresh race"
oauth project:AUTH status:in_progress
"rate limit" priority:high assignee:me
project:AUTH status:todo,in_progress
updated:>=2026-08-01
AUTH-142
```

### Text clauses

- Whitespace separates clauses.
- Bare words are full-text terms.
- Double quotes form a phrase. A phrase must close before the end of the query.
- Within quotes, `\"` represents a double quote and `\\` represents a
  backslash. Any other backslash escape is invalid.
- Adjacent text clauses use AND. Every text clause must match one indexed
  document.
- Matching is case-insensitive.
- FTS tokenization uses `unicode61` with diacritic removal.
- There are no stop words and no stemming. `refresh` does not match
  `refreshing`.
- V1 has no general `OR`, negation, parentheses, wildcards, prefix matching,
  fuzzy matching, regular expressions, or proximity operators.

The server quotes and escapes each parsed term before passing it to FTS5.
Punctuation in user input never becomes an FTS operator.

A ticket and each of its comments are separate indexed documents. All text
terms must match either the ticket document or one individual comment. Terms
do not combine across two comments or across a ticket and a comment. The
server collapses matching documents into one ticket result and keeps the best
match as its excerpt.

### Qualifiers

Qualifiers use `name:value`. Values containing spaces use double quotes. The
`project`, `status`, `priority`, and `assignee` qualifiers accept
comma-separated alternatives.

```text
project:AUTH
status:backlog,todo,in_progress,in_review,done,canceled
priority:none,low,medium,high,urgent
assignee:gabe@acme.com
assignee:me
assignee:none
created:>=2026-08-01
updated:<2026-08-26
```

All qualifiers combine with AND. Comma-separated values within one qualifier
combine with OR. Repeating a qualifier is invalid. This avoids ambiguous cases
such as `status:todo status:done`.

`project` accepts one or more project keys. The server normalizes keys to
uppercase. `status` and `priority` accept only their schema enum values.
`assignee` accepts normalized member email addresses plus `me` and `none`.
Suspended members remain valid filter values because tickets can remain
assigned to them.

`created` and `updated` accept `=`, `<`, `<=`, `>`, or `>=` followed by an RFC
3339 timestamp or an ISO 8601 calendar date. A date means midnight UTC. The
server compares stored UTC timestamps. Date qualifiers accept one comparison,
not a comma-separated list.

A bare value matching the ticket-key format becomes an exact key predicate.
It can be combined with text and qualifiers. A query may contain at most one
ticket key. Internal ULIDs are not searchable.

Filters-only queries are valid. They default to updated-time ordering because
they have no relevance score. An empty or whitespace-only query is invalid.

Unknown qualifiers, unknown enum values, invalid dates, repeated qualifiers,
an unclosed quote, and empty qualifier values return `422 invalid_search_query`
with a short message and the byte offset of the error. The parser stops at the
first error.

The UTF-8 query may be at most 4 KiB and may contain at most 50 clauses. A
larger query returns `422 search_query_too_large` before any SQL runs.

## What is not searchable

Search does not match project display names or descriptions, member names or
emails, comment authors, timestamps rendered as text, status names, priority
names, internal IDs, or Markdown frontmatter. Qualifiers cover the structured
ticket fields that matter for discovery.

Labels are deferred with the label implementation. That work may add a
`label:` qualifier without changing the text grammar. Project discovery stays
in the project commands.

## FTS schema

Migration 7 adds one content-bearing FTS5 virtual table. Each row is one search
document:

```sql
CREATE VIRTUAL TABLE ticket_search USING fts5(
  ticket_id UNINDEXED,
  source_kind UNINDEXED,
  source_id UNINDEXED,
  title,
  description,
  comment,
  tokenize = 'unicode61 remove_diacritics 2'
);
```

`source_kind` is `ticket` or `comment`. A ticket document stores its title and
description. A comment document stores only its comment body. `source_id`
holds the ticket or comment ULID so maintenance and result enrichment do not
depend on an FTS row ID.

Separate comment documents matter. Concatenating every comment into one ticket
row would rewrite the full comment history on every append and could create an
unbounded SQLite value. Per-comment rows keep comment insertion proportional
to the new comment.

The FTS table is derived data. `tickets` and `comments` remain authoritative.
The migration backfills both tables before it advances `schema_version`.
Migration failure rolls back the table, triggers, and backfill together.

### Index maintenance

SQLite triggers keep the index current:

- Ticket insert creates its ticket document.
- Changes to ticket title or body replace its ticket document.
- Ticket metadata changes do not touch FTS.
- Comment insert creates one comment document.
- Ticket delete removes its ticket document and every comment document for
  that ticket.

Comments are append-only, so v1 needs no comment update path. The ticket-delete
trigger performs explicit FTS cleanup rather than depending on cascaded-delete
trigger behavior.

The write and its trigger effects occur in the same Durable Object SQLite
transaction. A search that begins after commit observes the change. A failed
index update fails the source write as well.

Tests must be able to discard and rebuild `ticket_search` from the source
tables. V1 does not expose index repair through the public API or CLI. An
unexpected FTS failure returns `500 search_unavailable` and records the server
error without including the query text in the client response.

## Matching and ranking

FTS queries use BM25 with these starting column weights:

| Column | Weight |
|---|---:|
| Title | 10 |
| Description | 3 |
| Comment | 1 |

These values are part of the implementation, not the wire contract. Tests
assert ordering relationships such as title before description before comment,
not exact floating-point scores.

The query collects matching search documents, selects the best-ranked document
for each ticket, then orders ticket results by:

1. Best BM25 rank.
2. Ticket `updated_at` descending.
3. Ticket key ascending.

The API does not return the raw BM25 value. An exact-key-only query bypasses
FTS. With no text clause, results sort by `updated_at` descending and then
ticket key ascending.

V1 supports three sort modes:

- `relevance`, the default when text is present.
- `updated`, newest first.
- `created`, newest first.

Requesting `relevance` for a filters-only query is invalid. Sort direction is
fixed in v1.

## Result contract

Each result contains enough information to identify and triage a ticket, but
not the full description or comment history:

```json
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
    "comment_id": "01K3...",
    "excerpt": "...the refresh lock is per-process..."
  }
}
```

`assignee` is a normalized email or null. `match.source` is `key`, `ticket`, or
`comment`. `comment_id` appears only for a comment match. An exact-key result
has a null excerpt.

The server uses FTS5 `snippet()` to select an excerpt of at most 32 tokens. It
returns plain UTF-8 with `...` around omitted text. It does not return HTML,
ANSI escapes, Markdown emphasis, or caller-controlled highlighting markers.
Ticket content is untrusted text, so every transport renders the excerpt as
text.

Search results are summaries. MCP discovery must pair search with a separate
ticket-read tool. That tool belongs to the MCP design and is not part of this
feature.

## Pagination

The default page size is 20 tickets and the maximum is 100. The response does
not compute a total count.

```json
{
  "results": [],
  "next_cursor": null
}
```

`next_cursor` is an opaque base64url value that binds the normalized query,
filters, sort mode, and last ordering tuple. Supplying it with different
search inputs returns `422 invalid_search_cursor`. Cursor fields are parsed as
untrusted input and bound as SQL parameters.

Pagination is not a snapshot. Writes between pages may change ranking or move
a ticket across the cursor. A caller that needs a fresh complete traversal
restarts from the first page.

## HTTP API

Search uses `POST /search`. POST avoids URL-length and quoting problems while
keeping the operation read-only.

```json
{
  "query": "oauth project:AUTH status:todo,in_progress",
  "sort": "relevance",
  "limit": 20,
  "cursor": null
}
```

`query` is required. `sort`, `limit`, and `cursor` are optional. The shared
Rust schema owns the request, response, result, match, sort, and error-detail
types. Code generation produces the TypeScript types, and fixture tests cover
round trips in both languages.

The Worker route allowlist forwards the request to the tenant Durable Object.
The Durable Object checks initialization, authenticates the bearer token, and
authorizes `work.search` before parsing or running the query. Every active
admin, member, and viewer may search with a token that has `read` access or
higher. Agent and human tokens behave the same.

V1 has no restricted projects, so every authorized search covers the full
tenant. Future project privacy must add search filtering before it exposes any
restricted data.

Searches do not enter the audit log. Authentication failures follow the
existing API errors. Before tenant setup, `/search` returns
`409 setup_required`.

## CLI

The CLI command is:

```console
flat search QUERY [--sort relevance|updated|created] [--limit N]
                  [--cursor TOKEN] [--json]
```

`QUERY` is one argument. Shell users quote a query that contains spaces:

```console
flat search '"token refresh" project:AUTH status:in_progress'
```

The command calls the server directly. It does not run `flat sync`, inspect
the mirror, or require a clean working copy.

Human output prints the ticket key, status, priority, assignee, title, and
excerpt. `--json` prints the HTTP response shape without changing field names.
The default output prints the next cursor when another page exists.

A successful search exits zero, including when it finds no tickets. Transport,
authentication, authorization, and query errors use the CLI's existing
nonzero error path. Search never falls back to `rg` after a server error.

Adding the command must update `skills/flat/SKILL.md` in the same change. The
skill should continue to teach `rg` for local working-copy search and explain
that `flat search` reads accepted server state.

## MCP

Both MCP transports expose a `search` tool with the same fields as the HTTP
request. The structured result uses the HTTP response shape. The local MCP
tool still calls the server. It does not build a local index or search the
Markdown mirror.

MCP descriptions must state that results reflect server state and that local
unpushed edits are absent. MCP clients may follow a search result with the
separate ticket-read tool.

## Implementation order

1. Add search types and fixtures to the Rust schema, then regenerate
   TypeScript.
2. Add migration 7 with `ticket_search`, maintenance triggers, and a complete
   backfill.
3. Implement and unit-test the query lexer, parser, normalization, and FTS
   compiler.
4. Implement ranked retrieval, result grouping, excerpts, filters, sorting,
   and cursor pagination in the tenant Durable Object.
5. Add `POST /search`, route validation, authentication, and `work.search`
   authorization.
6. Add `flat search`, human output, JSON output, and the Flat skill update.
7. Add the local and remote MCP tool when each MCP transport ships.

## Acceptance criteria

The server and CLI search slice is complete when tests prove all of the
following:

- Ticket titles and descriptions are searchable immediately after commit.
- A new comment is searchable immediately after commit.
- Updating a ticket removes old title and description terms from the index.
- Deleting a ticket removes its ticket and comment matches.
- The migration backfills tickets and comments that predate the FTS table.
- One ticket appears once when several of its documents match.
- The best matching document supplies the excerpt.
- Title matches rank before equivalent description matches, which rank before
  equivalent comment matches.
- Exact ticket keys resolve case-insensitively and bypass FTS when no text is
  present.
- Every qualifier accepts its documented values and rejects malformed values.
- Text and qualifiers combine with the documented AND and OR rules.
- Raw FTS syntax is escaped rather than executed.
- Empty, oversized, and malformed queries return stable validation errors.
- Filters-only queries work and reject relevance sorting.
- Pagination has deterministic tie-breakers and rejects a cursor from another
  query.
- Search returns no more than 100 results per request and computes no total.
- Admins, members, viewers, human tokens, and agent tokens with read access can
  search.
- Missing, expired, revoked, suspended, and underprivileged principals fail
  through the existing authorization path.
- Search before setup returns `setup_required`.
- `flat search` does not sync or read the local mirror.
- CLI success, empty results, JSON output, cursor output, and server failures
  have stable exit and output behavior.

MCP acceptance tests reuse the same contract cases when the transports ship.
