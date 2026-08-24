// Worker entry: bearer auth, then forward to the single tenant Durable
// Object (one company = one deployment = one DO = one ordered mutation log).

export { Tenant } from "./tenant";

export interface Env {
  TENANT: DurableObjectNamespace;
  /** Set via `wrangler secret put ADMIN_TOKEN` (or .dev.vars locally). */
  ADMIN_TOKEN?: string;
}

function error(status: number, code: string, message: string): Response {
  return Response.json({ error: code, message }, { status });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.ADMIN_TOKEN) {
      return error(500, "misconfigured", "server has no ADMIN_TOKEN secret set");
    }
    const auth = request.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
    if (token.length === 0 || !timingSafeEqual(token, env.ADMIN_TOKEN)) {
      return error(401, "unauthorized", "missing or invalid bearer token");
    }

    const url = new URL(request.url);
    if (url.pathname === "/") {
      return Response.json({ service: "flat tee", protocol_version: 1 });
    }
    const stub = env.TENANT.get(env.TENANT.idFromName("tenant"));
    return stub.fetch(request);
  },
};

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}
