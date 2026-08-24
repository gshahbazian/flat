// Cloudflare infrastructure as code (Alchemy: https://alchemy.run).
//
//   FLAT_TOKEN=<bearer token> ALCHEMY_PASSWORD=<state passphrase> pnpm deploy
//
// Local development doesn't go through here — that's `pnpm dev` in /server,
// which reads server/wrangler.jsonc and server/.dev.vars.
import alchemy from "alchemy";
import { DurableObjectNamespace, Worker } from "alchemy/cloudflare";

const flatToken = process.env.FLAT_TOKEN;
if (!flatToken) {
  throw new Error("set FLAT_TOKEN: the bearer token clients will use against this deployment");
}

const app = await alchemy("flat");

// The single tenant DO: one instance holds every table and the ordered
// mutation log. SQLite-backed, matching server/wrangler.jsonc's migration.
const tenant = DurableObjectNamespace("tenant", {
  className: "TenantDO",
  sqlite: true,
});

export const server = await Worker("server", {
  name: "flat-server",
  entrypoint: "../server/src/index.ts",
  compatibilityDate: "2025-10-01",
  url: true,
  bindings: {
    TENANT: tenant,
    FLAT_TOKEN: alchemy.secret(flatToken),
  },
});

console.log(`flat server: ${server.url}`);

await app.finalize();
