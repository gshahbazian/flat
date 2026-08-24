# Server

Cloudflare Worker and Durable Object that host the ticket backend.

- `src/index.ts` — Worker entry: bearer auth (`FLAT_TOKEN`), routes to the DO.
- `src/tenant.ts` — the single tenant DO: `tickets`, the ordered `mutation_log`,
  `applied_mutations` (idempotency), and the seeded `DEMO` project counter,
  all in DO SQLite.
- `src/schema.gen.ts` — generated from `/schema` by `scripts/codegen.sh`; do not edit.

## Endpoints

- `POST /sync` — mutations up, deltas down, one round trip.
- `GET /snapshot` — bootstrap: all tickets + the seq watermark.

## Develop

```sh
pnpm install
pnpm dev        # wrangler dev on :8787; token comes from .dev.vars
pnpm test       # fixture round-trip tests (vitest)
pnpm typecheck
```

Deployment config lives in `/infra`; `wrangler.jsonc` here is local dev only.
