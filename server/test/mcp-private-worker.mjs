export { TenantDO } from '../src/tenant.ts'

export default {
  fetch(request, env) {
    const stub = env.TENANT.get(env.TENANT.idFromName('tenant'))
    const url = new URL(request.url)
    return stub.fetch(new Request(`https://tenant.invalid${url.pathname}${url.search}`, request))
  },
}
