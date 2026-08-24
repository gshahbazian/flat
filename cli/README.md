# CLI

The Rust `flat` CLI.

```
flat init --server URL --token TOKEN   # connect + first snapshot
flat new TITLE                         # create a ticket, materialize DEMO-N.md
flat sync                              # pull server changes into the mirror
flat push                              # send locally edited files back
flat path                              # print the mirror location
```

The mirror lives at `~/.flat/<host>/DEMO/DEMO-N.md` (`FLAT_DIR` overrides the
root). Base copies and sync state sit next to it under `~/.flat/<host>/.flat/`;
`flat push` diffs each file against its base copy and sends one atomic update
mutation per dirty ticket.

Notes:

- `flat new` journals its mutation under `.flat/pending/` before sending; if
  the response is lost, the next `flat sync` replays the same mutation_id
  (idempotent server-side) instead of a rerun creating a duplicate ticket.
- Rerunning `flat init` treats the snapshot as authoritative: local state is
  reset and tickets absent from the server disappear from the mirror.
- Known limitation: concurrent `flat` commands against the same checkout are
  not serialized; last write to `state.json` wins. Locking arrives with the
  planned SQLite state db.
