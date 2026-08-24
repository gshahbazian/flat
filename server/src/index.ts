// Worker entry: bearer auth, then forward API routes to the single tenant DO.
export { TenantDO } from "./tenant";

export interface Env {
  TENANT: DurableObjectNamespace;
  FLAT_TOKEN: string;
}

function error(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.FLAT_TOKEN) {
      return error(500, "server is missing the FLAT_TOKEN secret");
    }
    const auth = request.headers.get("Authorization");
    if (auth !== `Bearer ${env.FLAT_TOKEN}`) {
      return error(401, "missing or invalid bearer token");
    }

    const { pathname } = new URL(request.url);
    const isSync = request.method === "POST" && pathname === "/sync";
    const isSnapshot = request.method === "GET" && pathname === "/snapshot";
    if (!isSync && !isSnapshot) {
      return error(404, `no route for ${request.method} ${pathname}`);
    }

    // Single tenant: one deployment = one DO instance = one ordered log.
    const stub = env.TENANT.get(env.TENANT.idFromName("tenant"));
    return stub.fetch(request);
  },
};
