---
name: flat
description: Use an existing Flat CLI installation to manage Flat tickets, labels, or projects when the user names Flat, provides a Flat ticket or project key, or refers to work known to be in Flat. Do not use for generic task management or when `flat` is not installed and configured.
---

# Flat

Flat keeps shared tickets on a server and syncs them to local Markdown files.
Treat those files as a working copy of the server state.

Use this skill only when the `flat` command is already available and
configured. If it is missing or reports that no checkout exists, stop using
Flat. Do not install it, run `flat init`, or change credentials. If the server
rejects an operation for lack of permission, report that instead of attempting
to gain access.

## Read tickets

Run `flat sync` before relying on the local ticket state. `flat path` prints the
checkout root; mirrored ticket files are grouped into project directories
below it. Search and read the Markdown files there with ordinary filesystem
tools such as `rg` and `cat`.

Use `flat search 'QUERY'` when the user wants accepted server state rather than
the local working copy. It searches ticket titles, descriptions, and comments,
with filters such as `project:AUTH`, `status:todo,in_progress`,
`priority:high`, `label:bug`, `label:none`, `assignee:me`, and
`updated:>=2026-08-01`. Add `--json` for the
wire response, or `--sort updated|created`, `--limit N`, and `--cursor TOKEN`
for explicit ordering and pagination. Server search does not sync first and
does not include unpushed edits, manually created files, or conflict markers.
Continue to use `rg` when local working-copy state is what matters.

Each ticket is a Markdown file:

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

### claude (for gabe@acme.com) — 2026-08-25T14:10:00.000Z
Reproduced with two concurrent refreshes.
```

## Write tickets

`flat new TITLE --project KEY [--priority PRIORITY] [--assignee EMAIL]
[--label NAME]...` creates
a ticket on the server and writes its Markdown file to that project's mirror
directory. `--project` is required. Run `flat project ls` after syncing to
find valid project keys. Do not create ticket files by hand; `flat push` skips
files that were not materialized by Flat.

Edit an existing file's `title`, `status`, `priority`, `assignee`, `labels`, or
description body directly. Labels use a sorted inline list such as
`labels: [auth, bug]`; use `labels: []` for none. Legacy ticket files without
`labels` are treated as unlabeled. The `id`, `project`, `created`, `updated`, filename,
and everything from the `<!-- flat:comments -->` sentinel onward are read-only.
The exact sentinel line is reserved and cannot appear in the description body.
Valid statuses are `backlog`, `todo`, `in_progress`,
`in_review`, `done`, and `canceled`. Valid priorities are `none`, `low`,
`medium`, `high`, and `urgent`. Assignees are member email addresses; use
`assignee: null` to
clear an assignment. Flat normalizes assignment emails and resolves them from
the synced member profiles. If an assignee cannot be found locally, run
`flat sync` and retry. Run `flat push` to publish local edits to the server.

## Manage labels

Run `flat sync` before relying on label state. List or inspect labels with
`flat label ls` and `flat label show NAME`. Create one with
`flat label create NAME`, rename it with
`flat label update NAME --new-name NEW_NAME`, and delete it with
`flat label delete NAME`. Names are normalized lowercase ASCII slugs; `none`
is reserved for search, and a claimed name is never reused. Create and rename
require write access. Delete requires an admin human token and removes the
label from every ticket.

When editing a ticket, use only names returned by `flat label ls`. Unknown
names fail the push with a direction to sync. Concurrent label additions and
removals merge as set changes rather than producing conflict markers.

## Add comments

Add an append-only comment with `flat comment KEY TEXT`. For multiline
Markdown, pipe the content to `flat comment KEY --stdin`. A comment must
contain non-whitespace content and may be at most 1 MiB of UTF-8. Do not edit
the rendered comment section in a ticket file; `flat push` rejects changed,
deleted, or mangled comment sections.

A comments-only sync updates that read-only suffix even when editable ticket
fields have local changes. CRLF conversion and final newlines do not count as
comment edits; changing rendered comment content does.

If Flat reports a pending mutation, run `flat sync` before adding another
comment. This replays the original mutation ID instead of creating a duplicate.

Comments record the accepted token on the server. Human comments render the
member email. Agent comments render the agent name and member email, including
the delegating member when an admin created the agent token for someone else.

## Manage projects

Run `flat sync` before relying on project state. `flat project ls` lists all
projects and `flat project show KEY` shows one. Create a project with
`flat project create KEY --name NAME [--description TEXT]`. Project keys use
2-8 uppercase letters or digits, must start with a letter, and cannot be
changed or reused. Project descriptions may contain at most 256 KiB of UTF-8.
The creator becomes the first owner.

Every tenant starts with a `DEMO` project owned by the claiming admin.

Project owners with `write` access can change metadata with
`flat project update KEY --name NAME`,
`flat project update KEY --description TEXT`, or both flags together. Manage
owners with `flat project owner add KEY EMAIL` or
`flat project owner remove KEY EMAIL`. An admin with `write` access may change
any project's metadata, but changing owners on a project they do not own,
including recovering an ownerless project, requires a human `admin` token.
`flat project delete KEY` also requires a human `admin` token and fails while
the project contains tickets.

## Delete tickets

Deleting a mirrored file only discards its local edits; the next `flat sync`
restores the server copy. To delete the server ticket, run `flat delete KEY`
only when the user explicitly requests deletion. This command requires an
admin human token; agent tokens cannot delete tickets.

## Handle conflicts

`flat sync` preserves local edits when editable server fields also changed and
exits nonzero. Run `flat sync --merge` to merge the changes. If they overlap,
Flat writes `<<<<<<< local` / `>>>>>>> server` conflict markers into the
ticket file. Resolve every marker before running `flat push`; both sync and
push refuse to complete while markers remain. A failure to merge one ticket
does not prevent Flat from merging other tickets in the same run.
