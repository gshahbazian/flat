# Infra

Cloudflare infrastructure as code, written with [Alchemy](https://alchemy.run)
(pinned to the stable 0.x line; 2.0 is an Effect-based rewrite still in beta).
`alchemy.run.ts` declares the Worker and the SQLite-backed tenant Durable
Object. It creates persistent random resources for the credential HMAC key and
one-time setup secret, then installs only the key ring and setup verifier in
the Worker.

```sh
pnpm install
ALCHEMY_PASSWORD='<state-passphrase>' pnpm deploy
pnpm destroy   # tear it back down
```

- `ALCHEMY_PASSWORD` encrypts secrets in Alchemy's state (`.alchemy/`, gitignored).
- Cloudflare credentials come from `wrangler login` or `CLOUDFLARE_API_TOKEN`.
- The deploy output prints the `flat_setup_...` credential. Use it once with
  `flat init HOST --setup`; later deploys cannot reopen an initialized tenant.
- Keep the encrypted Alchemy state. Losing the HMAC key intentionally revokes
  every token and live enrollment issued under it.

## Operator recovery

Use the same Alchemy state, Cloudflare account, stage, and profile as the normal
deployment:

```sh
ALCHEMY_PASSWORD='<state-passphrase>' pnpm recover -- --stage prod
```

The command prompts for the deployed HTTPS URL and an existing active admin
email. It generates a one-time operator credential, installs only its HMAC
verifier, creates a 15-minute recovery enrollment, prints that recovery code
once, and removes the verifier in a second deployment. It always attempts the
cleanup deployment, including when installation or the recovery request fails.

If cleanup fails, rerun the normal deployment with the same stage and profile.
After a successful recovery request, the Durable Object also records the
verifier as consumed, so leftover configuration cannot reuse it. Redeem the
recovery code with `flat init https://<flat-host> --recover`; enter the code at
the prompt, never in argv.

Local development doesn't go through here: `pnpm dev` in `/server` uses
`server/wrangler.jsonc` and `server/.dev.vars`.
