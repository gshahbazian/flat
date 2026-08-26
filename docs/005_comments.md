# Comments

Status: implemented.

Comments are append-only Markdown attached to tickets. They exercise the
existing ordered mutation log, member profiles, token attribution,
permissions, audit records, sync withholding, three-way merge, and CLI
mutation journal. The comment body is also ready for the later FTS slice to
index.

## Contract and persistence

A comment has an immutable ULID, parent ticket ULID, Markdown body, creation
time, and global tenant sequence. It captures the effective member, accepted
token, token kind, agent name, and delegating member at creation time. Those
safe attribution fields remain available after token revocation or member
suspension; private token rows never enter normal sync data.

Comments use the general mutation envelope with `entity: comment`, `op:
create`, and `set.ticket` plus `set.body`. Update and delete operations are not
accepted. Bodies must contain non-whitespace content and may contain at most 1
MiB of UTF-8. The server enforces both rules even when the CLI has already
validated them.

Migration 6 creates the comments table and its `(ticket_id, seq)` index. A
ticket delete cascades to its comments because comments belong to the deleted
ticket aggregate; there is no direct comment deletion operation.

Comment creation, mutation logging, idempotency storage, and its
`comment.create` audit event commit in one transaction and share one sequence.
The audit metadata records the mutation ID but never the comment body.

## Sync and conflicts

Snapshots include all comments. Sync responses include `comment_deltas`, and
a comment delta also causes its current parent ticket row to appear in ticket
deltas. The parent row gives the CLI everything needed to rematerialize its
file, but the comment does not change the ticket's own `seq` or `updated_at`.
It therefore cannot conflict with a concurrent title, status, assignment, or
description edit.

The CLI caches comments by immutable ID and renders each ticket's comments in
sequence order. If the ticket file is clean, a new comment rematerializes it
immediately. If the ticket row's sequence is unchanged, the CLI knows the
parent delta is comments-only and replaces an untouched comment suffix while
preserving local edits above it. A real ticket-row change still preserves a
dirty file and requires `flat sync --merge`.

Comments ship as part of protocol 2 because there are no deployed older
clients or servers to preserve compatibility with.

## Mirror and CLI

Every newly rendered ticket ends with:

```markdown
<!-- flat:comments -->
## Comments

### gabe@acme.com — 2026-08-25T14:00:00.000Z
Human comment.

### claude (for maya@acme.com) — 2026-08-25T14:01:00.000Z
Agent comment.

### ticket-triage (for maya@acme.com, delegated by gabe@acme.com) — 2026-08-25T14:02:00.000Z
Admin-delegated agent comment.
```

Everything from the sentinel onward is read-only. Push compares that suffix
with the base copy byte-for-byte and rejects edits, deletion, duplication, or
a mangled sentinel with a direction to use `flat comment KEY`. The sentinel is
required in every mirror file. To discard a file with a missing sentinel,
delete it and run `flat sync` so Flat restores the base copy.
Suffix comparisons normalize CRLF and ignore final newline characters, but
any change to rendered comment content remains a read-only violation.

`flat comment KEY TEXT` adds a single-line or shell-quoted comment.
`flat comment KEY --stdin` reads multiline Markdown. One form is required and
they cannot be combined. The CLI journals the create mutation before sending.
While any mutation remains pending, another comment is refused and `flat sync`
replays the original mutation ID before a new comment can be added.

The exact `<!-- flat:comments -->` line is reserved and rejected in ticket
descriptions. Conflict-marker detection stops at that sentinel so matching
lines inside an immutable comment cannot block later syncs or pushes.

Admins and members with `write` token access may comment. Viewers cannot.
Human and agent tokens are both supported; attribution always comes from the
server principal and cannot be supplied by the mutation.
