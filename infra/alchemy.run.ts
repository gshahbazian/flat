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

function credentialVerifier(credential: string): string {
  return createHmac(
    'sha256',
    Buffer.from(hmacSecret.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  )
    .update(credential)
    .digest('hex')
}

const setupVerifier = credentialVerifier(setupCredential)
const operatorCredential = process.env.FLAT_OPERATOR_RECOVERY_CREDENTIAL
if (
  operatorCredential !== undefined &&
  !/^flat_oprec_[A-Za-z0-9_-]{43,}$/.test(operatorCredential)
) {
  throw new Error('FLAT_OPERATOR_RECOVERY_CREDENTIAL has an invalid format')
}

const tenant = DurableObjectNamespace('tenant', {
  className: 'TenantDO',
  sqlite: true,
})

const bindings = {
  TENANT: tenant,
  FLAT_HMAC_KEYS: alchemy.secret(JSON.stringify([{ id: keyId, secret: hmacSecret }])),
  FLAT_SETUP_VERIFIER: alchemy.secret(`${keyId}:${setupVerifier}`),
}
if (operatorCredential !== undefined) {
  Object.assign(bindings, {
    FLAT_OPERATOR_RECOVERY_VERIFIER: alchemy.secret(
      `${keyId}:${credentialVerifier(operatorCredential)}`
    ),
  })
}

export const server = await Worker('server', {
  name: 'flat-server',
  entrypoint: '../server/src/index.ts',
  compatibilityDate: '2026-01-28',
  compatibilityFlags: ['nodejs_compat'],
  url: true,
  bindings,
})

console.log(`flat server: ${server.url}`)
if (process.env.FLAT_OPERATOR_RECOVERY_DEPLOY !== '1') {
  console.log(`one-time setup code: ${setupCredential}`)
}

await app.finalize()
