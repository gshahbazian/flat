# Server

Cloudflare Worker and Durable Object that host the ticket backend.

- `src/index.ts` — exact route matching and forwarding to the tenant DO.
- `src/tenant.ts` — authentication, enrollment, authorization, audit,
  permission-aware sync, and transactional GitHub delivery handling.
- `src/policy.ts` — the shared action-based permission policy.
- `src/crypto.ts` — credential formats, HMAC verification, canonical hashing,
  and secret generation.
- `src/migrations.ts` — ordered SQLite migrations. GitHub receipts are version
  1, permissions tables are version 2, ticket tombstones are version 3, and
  priority, assignment, and ticket timestamps are version 4. Projects and
  ticket-to-project relationships are version 5.
- `src/github.ts` — PR closing-phrase parser and Web Crypto signature checks.
- `src/conflict.ts` — field-level conflict detection: an update against a
  stale base_seq applies unless it sets a field the server changed since
  (found by replaying the mutation log after base_seq).
- `src/schema.gen.ts` — generated from `/schema` by `scripts/codegen.sh`; do not edit.

## Endpoints

- `POST /sync` — mutations up, row deltas and deletion tombstones down, one
  round trip.
- `GET /snapshot` — bootstrap: all projects and tickets + the seq watermark.
- `POST /setup` — one-time tenant claim and first admin token.
- `POST /enroll/invite`, `POST /enroll/recover` — enrollment redemption.
- `/members`, `/tokens`, `/audit` — dedicated administrative APIs.
- `POST /hooks/github/setup` — get or rotate the tenant webhook secret.
- `POST /hooks/github` — signature-authenticated GitHub delivery endpoint.

Every private route is authenticated inside the Durable Object. Before setup,
normal routes return `409 {"error":"setup_required"}`. Successful webhook
requests return an empty `200`; authentication and input failures use the
same stable `{ "error": "code" }` JSON shape as the other APIs.

## Develop

```sh
pnpm install
pnpm dev        # wrangler dev on :8787; verifier config comes from .dev.vars
pnpm test       # fixture round-trip tests (vitest)
pnpm typecheck
```

Deployment config lives in `/infra`; `wrangler.jsonc` here is local dev only.
The checked-in local setup credential is documented in the root README.
