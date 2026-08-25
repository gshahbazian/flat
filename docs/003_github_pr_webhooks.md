# GitHub PR webhooks

Close a ticket when a pull request that names it merges into the repository's
default branch.

Status: implemented for the HTTP ticket-sync milestone. GitHub API write-back,
App installation, and activity/comment rendering remain out of scope.

## Goal

A merged PR that says `Fixes DEMO-1` marks `DEMO-1` as `done`.

This slice does one job. It does not track the PR through draft, review, and
merge. It does not write back to GitHub. It does not sync GitHub Issues.

The close is silent in v1. After `flat sync`, the ticket file shows
`status: done`, but it does not show which PR changed it. The delivery receipt
keeps that source data for a later comment or activity view.

## Why a repository or organization webhook

Flat only needs an authenticated event from GitHub. It does not need to call
the GitHub API or write to a repository. A webhook is enough.

A private GitHub App could also send this event. OAuth is optional for an App,
and an App does not need write access just to deliver pull request events. It
still asks each company to register and install an App. That setup buys us
nothing in this slice, so we will use a regular repository or organization
webhook.

If we later add PR comments, linkbacks, or automatic installation, we can
revisit the App. Those features need GitHub API access. Auto-close does not.

## How a PR names a ticket

Flat scans the PR title and body. It does not scan comments, branch names, or
commit messages.

The keyword match is case-insensitive. Flat accepts these words:

`close, closes, closed, closing, fix, fixes, fixed, fixing, resolve,
resolves, resolved, resolving, complete, completes, completed, completing`

This list is wider than GitHub's nine keywords on purpose: it adds the `-ing`
forms and the `complete` family. The extra words also fire on imperative
wording such as `complete DEMO-1 before launch` in a PR body. That is
intended — a merged PR that says this means to finish the ticket — but it is
a judgment call; drop the extra words if real deliveries prove them too eager.

The ticket key remains case-sensitive and uses the v1 pattern
`[A-Z][A-Z0-9]{1,7}-\d+`.

A closing phrase must fit on one line. The keyword must be a whole word. An
optional colon may follow it, then at least one space or tab, then a ticket
key. A newline between the keyword and key does not match.

After the first key, a list may use commas, `and`, or both. Either separator
may appear more than once. Spaces after a comma are optional. Sentence
punctuation after the last key is allowed. These all close the keys shown:

```text
Fixes DEMO-1, AUTH-2.                  -> DEMO-1, AUTH-2
Fixes DEMO-1,AUTH-2                    -> DEMO-1, AUTH-2
Fixes DEMO-1 and AUTH-2                -> DEMO-1, AUTH-2
Fixes DEMO-1, and AUTH-2               -> DEMO-1, AUTH-2
Fixes DEMO-1 and AUTH-2 and BILL-7     -> DEMO-1, AUTH-2, BILL-7
```

Scan the title and body separately. Never concatenate them because that could
join a keyword at the end of the title to a key at the start of the body.
Find every closing phrase in each field, union the two result sets, then remove
duplicate keys while keeping their first appearance. Two phrases in one field
both count, whether they are on the same line or different lines.

Treat a null PR body as an empty string.

Before scanning each field, strip HTML comments, fenced code blocks (both
``` and `~~~` fences), inline code, indented code blocks (lines indented four
or more spaces or a tab), and Markdown lines whose first non-space character
is `>`. Strip Markdown images entirely, alt text included, and reduce Markdown
links to their link text: alt text is not visible prose, link text is. An
example in a PR template must not close a ticket by accident.

These examples define the edge cases:

| Title or body text | Keys found |
| --- | --- |
| `Fixes DEMO-1.` | `DEMO-1` |
| `CLOSES: AUTH-2!` | `AUTH-2` |
| `Fixes DEMO-1, AUTH-2, and BILL-7` | `DEMO-1`, `AUTH-2`, `BILL-7` |
| `Fixes DEMO-1 AUTH-2` | `DEMO-1` only |
| `DEMO-1: fix the race` | none |
| `prefixFixes DEMO-1` | none |
| `Fixes demo-1` | none |
| title `Fixes`, body `DEMO-1` | none |
| title `Fixes DEMO-1`, body `Closes AUTH-2` | `DEMO-1`, `AUTH-2` |
| `Fixes DEMO-1. Also closes AUTH-2.` | `DEMO-1`, `AUTH-2` |
| `Fixes DEMO-1.` followed by `Closes AUTH-2.` on another line | `DEMO-1`, `AUTH-2` |
| `Fixes DEMO-1 and AUTH-2 and BILL-7` | `DEMO-1`, `AUTH-2`, `BILL-7` |
| `Fixes DEMO-1 and the tests` | `DEMO-1` |
| `Fixes DEMO-1,` | `DEMO-1` |
| `Fixes` at the end of one line, `DEMO-1` on the next | none |
| ``Example: `Fixes DEMO-1` `` | none |
| `![Fixes DEMO-1](shot.png)` | none |
| `[Fixes DEMO-1](https://pr.example)` | `DEMO-1` |

The parser accepts `.`, `,`, `;`, `:`, `!`, `?`, `)`, `]`, or `}` after the
last key. A key must otherwise end at whitespace, a list separator, or the end
of the field. If a separator is not followed by another valid key, the phrase
ends and the keys already found still count. Repeated keys count once.

Full ticket URLs are out of scope until Flat has a canonical ticket URL.

This grammar is ours. GitHub only recognizes nine closing keywords. It reads
them from a PR description or commit message, not the PR title, and requires a
keyword for each issue in a list. We accept more natural wording because Flat
ticket keys cannot collide with GitHub issue numbers. Parser tests are the
source of truth for these differences.

## When the hook closes a ticket

GitHub sends `POST /hooks/github` with these headers:

- `X-GitHub-Event: pull_request`
- `X-GitHub-Delivery: <guid>`
- `X-Hub-Signature-256: sha256=<hmac>`

The payload must meet all of these conditions:

- `action == "closed"`
- `pull_request.merged == true`
- `pull_request.base.ref == repository.default_branch`

The default-branch check matches GitHub's own issue-closing behavior. A PR
merged into a release branch does not close a Flat ticket.

The handler ignores closed but unmerged PRs, non-default branches, reopened
PRs, and draft changes. A valid ignored delivery returns 200.

GitHub sends a `ping` event when an admin creates the webhook. Flat verifies
its signature, then returns 200 with an empty body. It does not write to the
database.

## Ticket status rules

For each unique key in the PR:

- An open ticket — any status except `done` and `canceled` — moves to `done`
  and gets a new `seq`.
- A ticket already at `done` stays unchanged and does not get a new `seq`.
- A `canceled` ticket stays canceled.
- An unknown key is recorded in the delivery result but otherwise ignored.

Refusing to move a `canceled` ticket is the hook's own rule and the first
exception to 001's any-to-any transitions. Clients may still set any status;
only the hook declines to resurrect work someone explicitly abandoned.

One unknown or unchanged ticket does not block another ticket from closing.
The database still commits the whole delivery in one transaction. A database
error rolls back every close and the delivery receipt.

## Delivery receipts and mutation IDs

Webhook idempotency belongs to the whole delivery, not to one ticket mutation.
Migration 1 adds this table:

```sql
CREATE TABLE github_deliveries (
  delivery_id TEXT PRIMARY KEY,
  repository TEXT NOT NULL,
  pull_number INTEGER NOT NULL,
  pull_url TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  results_json TEXT NOT NULL
);
```

`processed_at` is an ISO 8601 UTC timestamp. `results_json` has a versioned
shape so later code can read old receipts:

```json
{
  "version": 1,
  "tickets": [
    { "key": "DEMO-1", "ticket_id": "01...", "result": "closed", "seq": 42 },
    { "key": "AUTH-2", "ticket_id": "01...", "result": "already_done", "seq": 18 },
    { "key": "BILL-7", "ticket_id": "01...", "result": "canceled", "seq": 9 },
    { "key": "OPS-4", "result": "unknown" }
  ]
}
```

The only result values in v1 are `closed`, `already_done`, `canceled`, and
`unknown`.

Every verified `pull_request` delivery that is closed, merged, and targeted at
the default branch gets a receipt, even if the parser finds no keys. Its
`tickets` array is empty. This freezes the outcome of that delivery so a later
parser change cannot reinterpret it during manual redelivery. `ping`, other
event types, irrelevant actions, unmerged PRs, and non-default branches do not
get receipts.

The handler runs one `transactionSync`:

1. Return 200 if the delivery GUID already exists.
2. Read each matching ticket and apply the status rules above.
3. Write one mutation log entry for every ticket that changed.
4. Insert the delivery receipt, including unknown and unchanged keys.

Use `github:<delivery-guid>:<ticket-id>` as the mutation ID for each changed
ticket. One delivery can close several tickets, so the delivery GUID alone is
not a valid mutation ID. The existing `applied_mutations` table remains for
client mutation replay. Webhook writes do not add rows to it.

These are the first mutation IDs that are not ULIDs. The server already treats
`mutation_id` as an opaque unique string, and webhook mutation IDs never
travel to clients, but the `schema/` doc comment promises a client-generated
ULID and the CLI orders its own pending mutation files by ULID name. Update
that doc comment to say the server accepts any opaque unique string, and never
add code that parses or sorts by the contents of a mutation ID.

For each key, the handler reads `id`, `status`, and `seq` from `tickets`. An
unknown key becomes an `unknown` result. For a ticket that should close, the
handler builds an update mutation with the resolved ULID as `entity_id`, the
row's current `seq` as `base_seq`, and `set.status = done`. It calls `apply()`
directly rather than going through `handleSync()`.

The read and update happen in the same transaction, so the `base_seq` check
should always pass. If `apply()` rejects after the key was resolved, treat that
as a server error. Throw, roll back every ticket change and the receipt, and
return 500. Do not turn a programming error into an `unknown` result or a
client-style conflict. There is no force-update path.

There is no actor field in the current mutation schema. Do not claim that the
log has a system actor. For v1, the delivery row holds the GitHub source and the
mutation ID connects each ticket change to that row. A later comments feature
can render `closed by acme/api#482` from the stored source data.

## Schema migrations

This feature introduces the migration mechanism that later schema changes
will use.

The bootstrap SQL continues to create `meta` and the current base tables with
`CREATE TABLE IF NOT EXISTS`. It also runs:

```sql
INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '0');
```

After bootstrap, the constructor reads `schema_version` and applies numbered
migrations in order. Each migration and its version update run in one
`transactionSync`. Migration 1 creates `github_deliveries`, then sets
`schema_version` to `1`. If either statement fails, the transaction rolls back
and the version stays at `0`.

Fresh DOs take the same path as existing DOs: bootstrap first, then migrations
from version `0`. Do not duplicate the latest tables in bootstrap. If the
stored version is newer than the server understands, fail startup instead of
running against an unknown schema.

The webhook secret lives in `meta` under `github_webhook_secret`. Migration 1
does not create a value. The first setup request inserts it, later setup
requests read it, and rotation replaces it. The current `setMeta()` helper only
updates existing rows, so first setup must not use it. Generate the secret,
then run `INSERT OR IGNORE` and read the stored value. Rotation can use
this upsert so it also works before setup has created the row:

```sql
INSERT INTO meta (key, value)
VALUES ('github_webhook_secret', ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value;
```

## Authentication and route ownership

The webhook secret lives in the tenant DO. The DO must also verify the
signature. Keeping the secret in the DO while checking the signature in the
Worker would require an extra secret lookup for every delivery and would split
one security boundary across two places.

The Worker bypasses bearer authentication only when the method is exactly
`POST` and the pathname is exactly `/hooks/github`. Do not use `startsWith`
or any other prefix match. In particular, `/hooks/github/setup` must never
enter the public branch. The Worker forwards the untouched webhook request to
the tenant DO.

The DO does this in order:

1. Read the raw request bytes.
2. Load the webhook secret.
3. Require `X-Hub-Signature-256` to contain `sha256=` followed by exactly 64
   hexadecimal characters. Decode those characters to a 32-byte MAC and use
   Web Crypto HMAC-SHA256 verification against the exact request bytes. Do not
   compare signature strings.
4. Validate `X-GitHub-Event` and `X-GitHub-Delivery`.
5. Require the `application/json` media type. An optional charset parameter is
   allowed.
6. Parse JSON only after the signature passes.
7. Handle `ping`, ignore an irrelevant event, or process a merged PR.

A missing secret, missing signature, malformed signature prefix or length,
invalid hex, and a failed MAC all return the same 401 status and body. A signed
request with missing delivery headers or malformed JSON returns 400. A signed
request with another content type returns 415. Every route other than the
exact webhook route still requires `Authorization: Bearer <FLAT_TOKEN>`.

Errors use the existing JSON shape, `{ "error": "..." }`. A verified `ping`,
an ignored event, a processed delivery, and a replay all return 200 with an
empty body.

The setup route remains bearer-authenticated at the Worker and is served by the
DO. The webhook route never trusts a header added by the caller to claim that
the Worker verified it.

### After the permissions design (002)

Every mention of `FLAT_TOKEN` in this document describes today's server. When
`002_permissions_system.md` lands, the shared secret is retired and this
feature adapts as follows:

- `POST /hooks/github/setup` requires a human token with `admin` access
  instead of `FLAT_TOKEN`.
- The webhook route is unchanged: signature verification stays its only
  authentication, and it never carries a bearer token.
- Webhook closes record `actor_kind: webhook` with the delivery ID as their
  source, per 002's audit model. Until then, the delivery receipt alone
  attributes the change.
- The two documents share one migration sequence. `github_deliveries` is
  migration 1; 002's tables take the next unclaimed numbers.

## Admin setup

The CLI is Flat's settings screen. Run:

```text
$ flat github
Payload URL:  https://flat-server.example.workers.dev/hooks/github
Content type: application/json
Secret:       <generated on first call and stored in the DO>
Events:       Pull requests

GitHub -> repository or organization Settings -> Webhooks -> Add webhook
```

`flat github` calls an authenticated setup route. The first call generates 32
random bytes and encodes them as 64 lowercase hexadecimal characters. Later
calls print the same secret.

```text
POST /hooks/github/setup           -> { secret }
POST /hooks/github/setup?rotate=1  -> { secret }
```

The CLI already knows the configured server URL, so it builds the payload URL
itself. The server does not need to infer its public URL from request headers.
Setup responses use `Cache-Control: no-store`, and neither the Worker nor the
DO logs the secret.

`flat github --rotate` replaces the secret immediately. Every existing GitHub
webhook will fail authentication until the admin updates it. This is blunt but
acceptable for v1. The command stays noninteractive. It prints a clear warning,
rotates, then prints the affected setup steps. One organization-level webhook
avoids repeating this work across repositories.

If setup has never run, `flat github --rotate` creates the first secret. The
command succeeds and prints the same setup instructions.

The shared secret creates a tenant-wide trust boundary. Any repository that
uses it can close any ticket key in that Flat tenant. A PR merged by a sandbox
or test repository can close a production ticket if both use the same webhook
secret. Admins should prefer one organization webhook covering repositories
with the same trust level. Per-repository secrets and repository allowlists
remain out of scope for v1.

We are not putting `GITHUB_WEBHOOK_SECRET` in Alchemy. The secret belongs to
tenant configuration, next to future integration settings. We are also not
asking the CLI to create GitHub webhooks through the API. That convenience can
come later and would still use the same stored secret.

## Local development

GitHub cannot reach `http://localhost:8787/hooks/github`. When the configured
server is local, `flat github` still prints the URL and secret for fixture or
manual HTTP tests, followed by a warning that GitHub cannot deliver to it.

Do not build a tunnel into this slice. Checked-in payload fixtures prove the
handler. A developer who wants a live delivery can run a separate tunnel such
as `cloudflared` or smee.

## Failure behavior

GitHub expects a 2xx response within 10 seconds. It records a 4xx, a 5xx, or a
timeout as a failed delivery. GitHub does not retry failed webhook deliveries
automatically.

An admin can manually redeliver a recent failure from GitHub. GitHub keeps the
same delivery GUID on redelivery, so the delivery receipt makes that safe.

The first slice does not add a queue or a redelivery poller. The DO work is a
small local transaction and should finish inside GitHub's deadline. If that
assumption fails in production, delivery history will show it and we can add a
queue with evidence that we need one.

## Worker and DO responsibilities

The Worker:

- keeps bearer authentication on the existing API and the setup route
- bypasses bearer authentication only for exact `POST /hooks/github`
- forwards the raw webhook request to the tenant DO

The tenant DO:

- creates, returns, and rotates the webhook secret
- verifies every webhook signature, including `ping`
- parses the PR title and body
- checks the event, merge state, and default branch
- processes all matched tickets and the delivery receipt in one transaction

GitHub payload types stay out of `schema/`. They are not part of the CLI and
server wire contract. Define the small payload shape the handler reads inside
the server package. Keep representative payloads in `server/test/fixtures/`.

## Tests

Signature and routing tests cover:

- GitHub's published HMAC test vector
- a valid signature, including a body with Unicode
- a wrong secret, missing header, and changed body
- a wrong prefix, wrong MAC length, and invalid hexadecimal MAC
- signature verification before JSON parsing
- missing event and delivery headers
- bearer authentication on every other route
- an exact-path test proving `/hooks/github/setup` is still private
- JSON with an optional charset and rejection of form-encoded payloads
- the JSON error shape and empty successful responses
- 64-character hex secret creation, first insert, repeat setup, rotation before
  setup, rotation after setup, and `Cache-Control: no-store`

Event tests cover:

- signed `ping`
- closed and merged into the default branch
- closed without merge
- merged into a non-default branch
- irrelevant actions and event types
- malformed signed payloads

Parser tests cover keyword case, optional colons, key boundaries, repeated
separators, incomplete list continuations, several phrases in one field,
title/body union, duplicate keys, bare keys, HTML comments, fenced and
indented code, images, links, quotes, and nullable PR bodies.

Database tests cover several tickets in one delivery, a mix of known and
unknown keys, `done`, `canceled`, and redelivery. Include a redelivery after an
unknown ticket is later created and after a canceled ticket changes status.
Neither case may apply an old delivery for the first time. Assert the exact
receipt result for every key and prove that webhook writes do not add rows to
`applied_mutations`. A relevant merge with no keys must write an empty receipt,
and its redelivery must remain a no-op.

Migration tests start from an existing version 0 database and from an empty
database. Both must reach version 1 with the same tables. A failed migration
must leave `schema_version` unchanged so the next DO start can retry it.

## Out of scope

- Reopening a ticket if a merge is reverted
- Rescanning when a merged PR's title or body is edited later — GitHub sends
  `action == "edited"`, not `closed`, so adding `Fixes DEMO-1` after the merge
  does not close the ticket
- Waiting for every linked PR before closing
- Branch-name and commit-message linking
- Moving a ticket to `in_progress` or `in_review`
- Writing a comment or link back to GitHub
- Per-repository secrets or a repository allowlist
- Creating the GitHub webhook through the API
- A queue or automatic failed-delivery poller
- GitHub Enterprise Server testing

## Implementation order

1. Add the migration runner, migration 1, and migration tests.
2. Add setup, secret generation, rotation, and their DO tests.
3. Add exact webhook routing and signature verification with routing and HMAC
   tests.
4. Add the parser with the positive and negative cases above.
5. Add transactional ticket updates, delivery receipts, and database tests.
6. Add `flat github`, `flat github --rotate`, and CLI tests.
7. Update the README with setup, the tenant-wide trust boundary, local
   development, silent closes, and failure behavior.
