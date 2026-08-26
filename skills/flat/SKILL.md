---
name: flat
description: Use an existing Flat CLI installation to read, create, update, or delete tickets when the user names Flat, provides a Flat ticket key, or refers to a ticket known to be in Flat. Do not use for generic task management or when `flat` is not installed and configured.
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
checkout root; mirrored ticket files are below it, currently in `DEMO/`. Search
and read the Markdown files there with ordinary filesystem tools such as `rg`
and `cat`.

Each ticket is a Markdown file:

```markdown
---
id: DEMO-1
title: Fix OAuth token refresh race
status: todo
priority: high
assignee: gabe@acme.com
created: 2026-08-25T12:34:56.000Z
updated: 2026-08-25T13:45:00.000Z
---

Description body.
```

## Write tickets

`flat new TITLE [--priority PRIORITY] [--assignee EMAIL]` creates a ticket on
the server and writes its Markdown file to the mirror. Do not create ticket
files by hand; `flat push` skips files that were not materialized by Flat.

Edit an existing file's `title`, `status`, `priority`, `assignee`, or
description body directly. The `id`, `created`, `updated`, and filename are
read-only. Valid statuses are `backlog`, `todo`, `in_progress`, `in_review`,
`done`, and `canceled`. Valid priorities are `none`, `low`, `medium`, `high`,
and `urgent`. Assignees are member email addresses; use `assignee: null` to
clear an assignment. Flat normalizes assignment emails and resolves them from
the synced member profiles. If an assignee cannot be found locally, run
`flat sync` and retry. Run `flat push` to publish local edits to the server.

## Delete tickets

Deleting a mirrored file only discards its local edits; the next `flat sync`
restores the server copy. To delete the server ticket, run `flat delete KEY`
only when the user explicitly requests deletion. This command requires an
admin human token; agent tokens cannot delete tickets.

## Handle conflicts

`flat sync` preserves local edits when the server copy also changed and exits
nonzero. Run `flat sync --merge` to merge the changes. If they overlap, Flat
writes `<<<<<<< local` / `>>>>>>> server` conflict markers into the ticket
file. Resolve every marker before running `flat push`; both sync and push
refuse to complete while markers remain.
