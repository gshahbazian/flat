import { createHmac } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { unstable_dev, type Unstable_DevWorker } from 'wrangler'
import { z } from 'zod'

import { mcpToolPath } from '../src/mcp-schema'

const HMAC_KEY = Buffer.alloc(32, 57)
const SETUP_CREDENTIAL = `flat_setup_${Buffer.alloc(32, 59).toString('base64url')}`
const SETUP_VERIFIER = createHmac('sha256', HMAC_KEY).update(SETUP_CREDENTIAL).digest('hex')

describe.sequential('private MCP executor', () => {
  let worker: Unstable_DevWorker
  let adminToken: string

  beforeAll(async () => {
    worker = await unstable_dev('test/mcp-private-worker.mjs', {
      config: 'wrangler.jsonc',
      persist: false,
      logLevel: 'error',
      vars: {
        FLAT_HMAC_KEYS: JSON.stringify([{ id: 'test', secret: HMAC_KEY.toString('base64url') }]),
        FLAT_SETUP_VERIFIER: `test:${SETUP_VERIFIER}`,
      },
      experimental: {
        disableExperimentalWarning: true,
        disableDevRegistry: true,
        watch: false,
      },
    })
    const setup = await worker.fetch('http://flat.test/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        setup_credential: SETUP_CREDENTIAL,
        email: 'admin@example.com',
        tenant_name: 'Private MCP test',
        token_name: 'admin-cli',
      }),
    })
    adminToken = z.object({ token: z.string() }).parse(await setup.json()).token
  }, 30_000)

  afterAll(async () => {
    await worker.stop()
  })

  test('requires a bearer token independently of the public Worker', async () => {
    const missing = await worker.fetch(`http://flat.test${mcpToolPath('list_projects')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(missing.status).toBe(401)
    expect(await missing.json()).toEqual({ error: 'invalid_token' })

    const valid = await worker.fetch(`http://flat.test${mcpToolPath('list_projects')}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    expect(valid.status).toBe(200)
  })
})
