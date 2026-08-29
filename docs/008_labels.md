# Labels

Status: implemented.

Labels are tenant-wide named entities and an editable set-valued ticket field.
They use the ordered mutation log, sync protocol, Markdown mirror, permissions,
search, audit, and idempotency behavior defined by the earlier design documents.

## Label model

A label has an immutable ULID, current name, creation and update timestamps,
and the sequence of its most recent mutation. Names are normalized by trimming
ASCII whitespace and lowercasing, then must match
`^[a-z0-9][a-z0-9._-]{0,63}$`. The name `none` is reserved for search.

Names are tenant-wide and permanently reserved once claimed, including after a
rename or delete. This prevents a stale checkout from resolving an old name to
a different label identity. Labels have no color or description in v1.

Ticket membership is stored as a many-to-many relation. The wire protocol uses
label ULIDs; Markdown files, CLI arguments, search, and human output use names.

## Mutations and permissions

Label CRUD uses the general mutation envelope with `entity: label`:

- Create requires `set.name` and no `base_seq`.
- Update requires `set.name` and the label's `base_seq`.
- Delete requires an empty set and the label's `base_seq`.

Admins and members with write access may create and rename labels. Deletion
requires an admin member using a human token with admin access. Label mutations
are audited as `label.create`, `label.update`, and `label.delete`.

Ticket create and update mutations use `labels_add` and `labels_remove` arrays
of label ULIDs. A label may not appear in both arrays, duplicates are rejected,
and every referenced label must exist. Additions of an existing membership and
removals of an absent membership are harmless. Concurrent label deltas commute
and do not conflict with scalar ticket fields or other label deltas; accepted
mutations apply in tenant sequence order.

Renaming a label rematerializes every ticket that uses it. Deleting a label
detaches it from every ticket and emits a label tombstone. Both operations
advance affected ticket rows so all mirrors receive full ticket deltas.

## Sync and Markdown

Labels extend protocol 2 additively: snapshots include labels, sync responses
include `label_deltas` and `label_tombstones`, ticket rows include label IDs,
and ticket mutations may include membership deltas. Older clients ignore these
fields. Updated clients treat absent label fields, pre-label local state, and
ticket Markdown without `labels` as empty.

The canonical editable ticket field is:

```yaml
labels: [auth, bug]
```

Names render in alphabetical order. An unlabeled ticket renders `labels: []`.
The CLI rejects malformed inline lists, duplicate names, and names absent from
the synced label cache. Push resolves names to ULIDs and sends set deltas.
`flat sync --merge` performs a set merge: local additions and removals apply to
the current server set without conflict markers.

## CLI

```console
flat new TITLE --project AUTH --label bug --label auth
flat label ls
flat label show NAME
flat label create NAME
flat label update NAME --new-name NEW_NAME
flat label delete NAME
```

Create is journaled before sending. Update and delete reuse the normal sync,
conflict, permission, and idempotency paths.

## Search and MCP

`label:bug` filters tickets by label name. Comma-separated names are
alternatives, so `label:bug,auth` matches either. `label:none` matches tickets
with no labels. Labels remain structured metadata and are not FTS text.

MCP exposes no standalone label list, create, update, or delete tools. The
existing `get_ticket`, `create_ticket`, and `update_ticket` tools include ticket
labels, and `search_tickets` accepts the shared `label:` qualifier.
