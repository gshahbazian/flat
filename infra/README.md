# Infra

Cloudflare infrastructure as code, written with [Alchemy](https://alchemy.run)
(pinned to the stable 0.x line; 2.0 is an Effect-based rewrite still in beta).
`alchemy.run.ts` declares the Worker and the SQLite-backed tenant Durable
Object, and injects `FLAT_TOKEN` as a secret binding.

```sh
pnpm install
FLAT_TOKEN=<bearer token> ALCHEMY_PASSWORD=<state passphrase> pnpm deploy
pnpm destroy   # tear it back down
```

- `FLAT_TOKEN` is the one bearer token clients use against this deployment.
- `ALCHEMY_PASSWORD` encrypts secrets in Alchemy's state (`.alchemy/`, gitignored).
- Cloudflare credentials come from `wrangler login` or `CLOUDFLARE_API_TOKEN`.

Local development doesn't go through here: `pnpm dev` in `/server` uses
`server/wrangler.jsonc` and `server/.dev.vars`.
