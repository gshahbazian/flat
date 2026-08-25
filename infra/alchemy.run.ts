// Cloudflare infrastructure as code. Alchemy keeps the generated credential
// material encrypted in state, so repeat deploys retain the same HMAC key.
import { createHmac } from 'node:crypto'

import alchemy from 'alchemy'
import { DurableObjectNamespace, Worker } from 'alchemy/cloudflare'
import { RandomString } from 'alchemy/random'

const app = await alchemy('flat')

const hmacMaterial = await RandomString('credential-hmac-key', {
  length: 32,
  encoding: 'base64',
})
const setupMaterial = await RandomString('one-time-setup-secret', {
  length: 32,
  encoding: 'base64',
})

function base64url(value: string): string {
  return value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const keyId = 'v1'
const hmacSecret = base64url(hmacMaterial.value.unencrypted)
const setupCredential = `flat_setup_${base64url(setupMaterial.value.unencrypted)}`
const setupVerifier = createHmac(
  'sha256',
  Buffer.from(hmacSecret.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
)
  .update(setupCredential)
  .digest('hex')

const tenant = DurableObjectNamespace('tenant', {
  className: 'TenantDO',
  sqlite: true,
})

export const server = await Worker('server', {
  name: 'flat-server',
  entrypoint: '../server/src/index.ts',
  compatibilityDate: '2025-10-01',
  url: true,
  bindings: {
    TENANT: tenant,
    FLAT_HMAC_KEYS: alchemy.secret(
      JSON.stringify([{ id: keyId, secret: hmacSecret }])
    ),
    FLAT_SETUP_VERIFIER: alchemy.secret(`${keyId}:${setupVerifier}`),
  },
})

console.log(`flat server: ${server.url}`)
console.log(`one-time setup code: ${setupCredential}`)

await app.finalize()
