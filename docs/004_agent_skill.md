# Flat agent skill

Status: implemented.

Flat ships with a small skill that customers can install for their coding
agents. The skill is named `flat` and lives at `skills/flat/SKILL.md`.

## Why it exists

Flat works differently from most ticket systems. It syncs tickets to Markdown
files and expects agents to read those files with ordinary shell tools. Running
`flat --help` shows the commands, but it does not explain that relationship
between the server and the local files.

The skill fills that gap. Customers can install it once instead of explaining
Flat in every repository.

## When it applies

The skill applies when a user names Flat, provides a Flat ticket key, or asks
the agent to update a ticket already known to be in Flat. A generic request
about tasks or tickets is not enough on its own.

The skill assumes that the CLI is installed and configured. If `flat` is not
available, the agent does not install it, run `flat init`, or continue with the
Flat workflow.

## What it teaches

The server holds the shared ticket state. The Markdown mirror is a local
working copy. The skill explains how to:

1. Sync the mirror with `flat sync`.
2. Find the checkout root with `flat path`, then search and read the mirrored
   ticket files beneath it with tools such as `rg` and `cat`.
3. Edit a ticket's `title`, `status`, and description. The `id` stays
   read-only.
4. Create a ticket with `flat new TITLE --project KEY`.
5. Publish local edits with `flat push`.
6. Use `flat sync --merge` and resolve conflict markers when local and server
   edits overlap.
7. Delete a server ticket with `flat delete KEY` only on an explicit request
   and with the required admin human token.

The skill lists every current status, including `in_progress` and `done`. It
does not tell the agent when to use them.

It also covers a few details that are easy to miss. Sync preserves local edits,
push refuses unresolved conflict markers, hand-created files are not tickets,
and deleting a mirrored file throws away its local changes rather than deleting
the server ticket. The next sync restores the server copy. Permission failures
are reported rather than worked around by changing credentials.

The skill stays in one file. It does not need scripts, assets, or separate
reference pages.

## Keeping it accurate

The skill documents the CLI that ships today, not the larger v1 design in
`001_initial_system.md`. A pull request that changes commands, ticket fields,
conflict handling, or any other behavior an agent sees must update
`skills/flat/SKILL.md` in the same change.

The repository's `AGENTS.md` records that rule. Update this design note only
when the purpose or scope of the skill changes.
