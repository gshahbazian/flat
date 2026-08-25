# Infra

Cloudflare infrastructure as code, written with [Alchemy](https://alchemy.run)
(pinned to the stable 0.x line; 2.0 is an Effect-based rewrite still in beta).
`alchemy.run.ts` declares the Worker and the SQLite-backed tenant Durable
Object. It creates persistent random resources for the credential HMAC key and
one-time setup secret, then installs only the key ring and setup verifier in
the Worker.

```sh
pnpm install
ALCHEMY_PASSWORD=<state passphrase> pnpm deploy
pnpm destroy   # tear it back down
```

- `ALCHEMY_PASSWORD` encrypts secrets in Alchemy's state (`.alchemy/`, gitignored).
- Cloudflare credentials come from `wrangler login` or `CLOUDFLARE_API_TOKEN`.
- The deploy output prints the `flat_setup_...` credential. Use it once with
  `flat init HOST --setup`; later deploys cannot reopen an initialized tenant.
- Keep the encrypted Alchemy state. Losing the HMAC key intentionally revokes
  every token and live enrollment issued under it.

Local development doesn't go through here: `pnpm dev` in `/server` uses
`server/wrangler.jsonc` and `server/.dev.vars`.
