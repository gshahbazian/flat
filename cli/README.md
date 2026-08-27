# CLI

The Rust `flat` CLI.

```
flat init URL --setup                  # claim a new tenant
flat init URL --invite                 # redeem an invitation
flat init URL --recover                # redeem a recovery enrollment
flat init URL --token                  # configure an existing FLAT_TOKEN
flat new TITLE --project KEY [--priority PRIORITY] [--assignee EMAIL]
flat sync [--merge]                    # pull server changes into the mirror
flat push                              # send locally edited files back
flat search QUERY [--sort MODE] [--limit N] [--cursor TOKEN] [--json]
                                        # search accepted server state
flat comment KEY TEXT                  # add an append-only comment
flat comment KEY --stdin               # read multiline Markdown from stdin
flat path                              # print the mirror location
flat member ...                        # invitations, roles, suspension, recovery
flat token ...                         # per-installation and agent credentials
flat audit ls                          # admin-only audit log
flat github [--rotate]                 # GitHub webhook settings
flat project ls
flat project show KEY
flat project create KEY --name NAME [--description TEXT]
flat project update KEY [--name NAME] [--description TEXT]
flat project owner add KEY EMAIL
flat project owner remove KEY EMAIL
flat project delete KEY                # admin human token; project must be empty
```

Project keys contain 2-8 uppercase letters or digits and start with a letter.
They are immutable and cannot be reused. The creator becomes the first owner.
Every tenant starts with a `DEMO` project owned by the claiming admin.
Project owners with `write` access may update metadata and owners. An admin
with `write` access may update any project's metadata, but changing owners on
a project they do not own requires a human `admin` token. Deleting an empty
project also requires a human `admin` token.

The mirror lives at `~/.flat/<host>/<PROJECT>/<PROJECT-N>.md` (`FLAT_DIR`
overrides the root). Base copies and sync state sit next to it under
`~/.flat/<host>/.flat/`;
`flat push` diffs each file against its base copy and sends one atomic update
mutation per dirty ticket.

Ticket frontmatter includes `id`, `project`, `title`, `status`, `priority`,
`assignee`, `created`, and `updated`. Edit `title`, `status`, `priority`,
`assignee`, and the description body. `id`, `project`, `created`, and `updated`
are read-only. Priority
is one of `none`, `low`, `medium`, `high`, or `urgent`; unassigned tickets use
`assignee: null`. Assignment emails use the shared normalization rules and are
resolved through synced member profiles. If an email is missing from the
local cache, run `flat sync` and retry.

Each file ends with a `<!-- flat:comments -->` section rendered from the
server's append-only comments. Everything from that sentinel onward is
read-only; `flat push` rejects changed, deleted, or mangled comment sections.
The exact sentinel line is reserved and cannot appear in a ticket description.
Use `flat comment KEY TEXT` or `flat comment KEY --stdin` instead. Comment
bodies preserve Markdown, must contain non-whitespace content, and are limited
to 1 MiB of UTF-8. Comment creates are journaled before sending. If a mutation
is already pending, `flat comment` requires `flat sync` to replay it before a
new comment can be added. A comments-only sync replaces the suffix while
preserving local edits above it. CRLF conversion and final newlines do not
count as edits to rendered comments.

Notes:

- `flat sync` applies comments-only suffix updates without touching local
  editable fields. When editable server fields also changed, sync without
  `--merge` reports the file and withholds that ticket's delta (last_seq
  doesn't advance, so the next sync re-delivers it); with `--merge` it
  three-way merges the server's changes in, leaving `<<<<<<< local` /
  `>>>>>>> server` conflict markers where both sides changed the same thing.
  `flat push` refuses files with unresolved markers, and `flat sync` exits
  non-zero as long as any mirror file still contains them.
- Deleting a mirror file discards its local edits: `flat sync` restores the
  last synced server state from the base copy.
- A ticket deleted on the server arrives as a tombstone. Sync removes its
  mirror file, base copy, and local state so another checkout cannot restore a
  stale copy.
- Setup, invitation, and recovery default the new human token name to the
  local hostname and let the user edit it before submission. `--name` keeps
  non-interactive enrollment available.
- `flat new` journals its mutation under `.flat/pending/` before sending; if
  the response is lost, the next `flat sync` replays the same mutation_id
  (idempotent server-side) instead of a rerun creating a duplicate ticket.
- Rerunning `flat init` treats the snapshot as authoritative: local state is
  reset and tickets absent from the server disappear from the mirror.
- Known limitation: nothing serializes concurrent access to a checkout —
  simultaneous `flat` commands race on `state.json` (last write wins), and an
  editor save in the instant between sync's clean-file check and its write
  can still be overwritten. Locking arrives with the planned SQLite state db.
