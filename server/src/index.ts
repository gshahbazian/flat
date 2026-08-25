// Worker entry. Credential verification and authorization happen in the DO,
// which is the final trust boundary for every transport.
export { TenantDO } from "./tenant";
import { isRoute } from "./routing";

export interface Env {
  TENANT: DurableObjectNamespace;
  FLAT_HMAC_KEYS: string;
  FLAT_SETUP_VERIFIER?: string;
  FLAT_OPERATOR_RECOVERY_VERIFIER?: string;
}

function error(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (!isRoute(request.method, pathname)) {
      return error(404, `no route for ${request.method} ${pathname}`);
    }

    const stub = env.TENANT.get(env.TENANT.idFromName("tenant"));
    return stub.fetch(request.clone());
  },
};
