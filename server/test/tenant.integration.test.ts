import { createHmac } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { unstable_dev, type Unstable_DevWorker } from 'wrangler'

import type { JsonInputValue, JsonValue } from '../src/request-schema'

const HMAC_KEY = Buffer.alloc(32, 7)
const HMAC_SECRET = HMAC_KEY.toString('base64url')
const SETUP_CREDENTIAL = `flat_setup_${Buffer.alloc(32, 9).toString('base64url')}`
const SETUP_VERIFIER = createHmac('sha256', HMAC_KEY).update(SETUP_CREDENTIAL).digest('hex')
type WorkerRequestInit = NonNullable<Parameters<Unstable_DevWorker['fetch']>[1]>
type WorkerResponse = Awaited<ReturnType<Unstable_DevWorker['fetch']>>

interface JsonResponse<T> {
  response: WorkerResponse
  body: T
}

type GithubPayload = {
  action: string
  number: number
  pull_request: {
    number: number
    title: string
    body: JsonValue
    merged: boolean
    html_url: string
    base: { ref: string }
  }
  repository: { full_name: string; default_branch: string }
}

async function json<T>(
  worker: Unstable_DevWorker,
  path: string,
  init: WorkerRequestInit = {}
): Promise<JsonResponse<T>> {
  const headers: Record<string, string> = {}
  new Headers(init.headers).forEach((value, name) => {
    headers[name] = value
  })
  if (init.body !== undefined && headers['content-type'] === undefined) {
    headers['content-type'] = 'application/json'
  }
  const response = await worker.fetch(`http://flat.test${path}`, {
    ...init,
    headers,
  })
  const text = await response.text()
  // SAFETY: Each test supplies T for the endpoint contract it exercises.
  return {
    response,
    body: text.length > 0 ? (JSON.parse(text) as T) : (null as T),
  }
}

function authenticated(token: string, body?: JsonInputValue): WorkerRequestInit {
  const init: WorkerRequestInit = {
    headers: { Authorization: `Bearer ${token}` },
  }
  if (body !== undefined) {
    init.method = 'POST'
    init.body = JSON.stringify(body)
  }
  return init
}

function githubRequest(
  secret: string,
  delivery: string,
  payload: JsonInputValue
): WorkerRequestInit {
  const body = JSON.stringify(payload)
  const signature = createHmac('sha256', secret).update(body).digest('hex')
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GitHub-Event': 'pull_request',
      'X-GitHub-Delivery': delivery,
      'X-Hub-Signature-256': `sha256=${signature}`,
    },
    body,
  }
}

describe.sequential('TenantDO integration', () => {
  let worker: Unstable_DevWorker

  beforeAll(async () => {
    worker = await unstable_dev('src/index.ts', {
      config: 'wrangler.jsonc',
      persist: false,
      logLevel: 'error',
      vars: {
        FLAT_HMAC_KEYS: JSON.stringify([{ id: 'test', secret: HMAC_SECRET }]),
        FLAT_SETUP_VERIFIER: `test:${SETUP_VERIFIER}`,
      },
      experimental: {
        disableExperimentalWarning: true,
        disableDevRegistry: true,
        watch: false,
      },
    })
  }, 30_000)

  afterAll(async () => {
    await worker.stop()
  })

  test('covers setup, mixed permissions, tombstones, revocation, and GitHub replay', async () => {
    const setup = await json<{
      token: string
      snapshot: { latest_seq: number }
    }>(worker, '/setup', {
      method: 'POST',
      body: JSON.stringify({
        setup_credential: SETUP_CREDENTIAL,
        email: 'admin@example.com',
        tenant_name: 'Test tenant',
        token_name: 'admin-cli',
      }),
    })
    expect(setup.response.status).toBe(200)
    const adminToken = setup.body.token

    const create = await json<{
      applied: Array<{ entity_id: string; seq: number }>
      conflicts: unknown[]
      latest_seq: number
    }>(
      worker,
      '/sync',
      authenticated(adminToken, {
        protocol_version: 2,
        last_seq: setup.body.snapshot.latest_seq,
        mutations: [
          {
            mutation_id: 'create-one',
            op: 'create',
            entity: 'ticket',
            entity_id: '01JG4C2Q4V8XKZ3W5D9E7F2H6M',
            set: { project: '00000000000000000000000000', title: 'First ticket' },
          },
          {
            mutation_id: 'create-two',
            op: 'create',
            entity: 'ticket',
            entity_id: '01JG4C5E2MZYXWVTSRQPNMKJHG',
            set: { project: '00000000000000000000000000', title: 'Second ticket' },
          },
        ],
      })
    )
    expect(create.response.status).toBe(200)
    expect(create.body.conflicts).toEqual([])
    const secondCheckoutSeq = create.body.latest_seq
    const firstCreate = create.body.applied.find((item) => item.entity_id.endsWith('F2H6M'))
    expect(firstCreate).toBeDefined()

    const invitation = await json<{ invitation_code: string }>(
      worker,
      '/members/invite',
      authenticated(adminToken, { email: 'member@example.com', role: 'member' })
    )
    expect(invitation.response.status).toBe(200)
    const enrollment = await json<{ token: string }>(worker, '/enroll/invite', {
      method: 'POST',
      body: JSON.stringify({
        credential: invitation.body.invitation_code,
        token_name: 'member-cli',
      }),
    })
    expect(enrollment.response.status).toBe(200)

    const mixed = await json<{
      applied: Array<{ mutation_id: string; seq: number }>
      conflicts: Array<{ mutation_id: string; reason: string }>
    }>(
      worker,
      '/sync',
      authenticated(enrollment.body.token, {
        protocol_version: 2,
        last_seq: secondCheckoutSeq,
        mutations: [
          {
            mutation_id: 'member-update',
            op: 'update',
            entity: 'ticket',
            entity_id: '01JG4C2Q4V8XKZ3W5D9E7F2H6M',
            base_seq: firstCreate?.seq,
            set: { title: 'Member updated' },
          },
          {
            mutation_id: 'member-delete',
            op: 'delete',
            entity: 'ticket',
            entity_id: '01JG4C5E2MZYXWVTSRQPNMKJHG',
            base_seq: create.body.applied.find((item) => item.entity_id.endsWith('NMKJHG'))?.seq,
            set: {},
          },
        ],
      })
    )
    expect(mixed.response.status).toBe(200)
    expect(mixed.body.applied.map((item) => item.mutation_id)).toEqual(['member-update'])
    expect(mixed.body.conflicts).toEqual([
      expect.objectContaining({
        mutation_id: 'member-delete',
        reason: 'forbidden',
      }),
    ])

    const deleteResponse = await json<{
      tombstones: Array<{ id: string; key: string; seq: number }>
    }>(
      worker,
      '/sync',
      authenticated(adminToken, {
        protocol_version: 2,
        last_seq: secondCheckoutSeq,
        mutations: [
          {
            mutation_id: 'admin-delete',
            op: 'delete',
            entity: 'ticket',
            entity_id: '01JG4C2Q4V8XKZ3W5D9E7F2H6M',
            base_seq: mixed.body.applied[0].seq,
            set: {},
          },
        ],
      })
    )
    expect(deleteResponse.response.status).toBe(200)
    expect(deleteResponse.body.tombstones).toEqual([
      expect.objectContaining({
        id: '01JG4C2Q4V8XKZ3W5D9E7F2H6M',
        key: 'DEMO-1',
      }),
    ])

    const malformed = await Promise.all(
      [-1, 1.5, 0x1_0000_0000].map((lastSeq) =>
        json<{ error: string }>(
          worker,
          '/sync',
          authenticated(adminToken, {
            protocol_version: 2,
            last_seq: lastSeq,
            mutations: [],
          })
        )
      )
    )
    for (const response of malformed) {
      expect(response.response.status).toBe(400)
      expect(response.body.error).toBe('malformed_sync_request')
    }

    const malformedMutations = await json<{
      applied: unknown[]
      conflicts: Array<{ mutation_id: string; entity_id: string; reason: string }>
    }>(
      worker,
      '/sync',
      authenticated(adminToken, {
        protocol_version: 2,
        last_seq: 0,
        mutations: [
          null,
          { entity_id: 'ticket-1' },
          {
            mutation_id: 'bad-entity-id',
            op: 'create',
            entity: 'ticket',
            entity_id: 42,
            set: {},
          },
          {
            mutation_id: 'bad-set',
            op: 'create',
            entity: 'ticket',
            entity_id: 'ticket-2',
            set: [],
          },
          {
            mutation_id: 'bad-title',
            op: 'create',
            entity: 'ticket',
            entity_id: 'ticket-3',
            set: { title: 42 },
          },
          {
            mutation_id: 'bad-status',
            op: 'create',
            entity: 'ticket',
            entity_id: 'ticket-4',
            set: { title: 'Title', status: 'unknown' },
          },
          {
            mutation_id: 'bad-priority',
            op: 'create',
            entity: 'ticket',
            entity_id: 'ticket-priority',
            set: { title: 'Title', priority: 'critical' },
          },
          {
            mutation_id: 'bad-assignee',
            op: 'create',
            entity: 'ticket',
            entity_id: 'ticket-assignee',
            set: { title: 'Title', assignee: 42 },
          },
          {
            mutation_id: 'read-only-timestamps',
            op: 'create',
            entity: 'ticket',
            entity_id: 'ticket-timestamps',
            set: { title: 'Title', created_at: '2026-08-25T12:34:56.000Z' },
          },
          {
            mutation_id: 'bad-base-seq',
            op: 'update',
            entity: 'ticket',
            entity_id: 'ticket-5',
            base_seq: -1,
            set: {},
          },
        ],
      })
    )
    expect(malformedMutations.response.status).toBe(200)
    expect(malformedMutations.body.applied).toEqual([])
    expect(malformedMutations.body.conflicts).toEqual([
      { mutation_id: '', entity_id: '', reason: 'malformed mutation' },
      { mutation_id: '', entity_id: 'ticket-1', reason: 'mutation_id is required' },
      { mutation_id: 'bad-entity-id', entity_id: '', reason: 'entity_id is required' },
      { mutation_id: 'bad-set', entity_id: 'ticket-2', reason: 'set must be an object' },
      {
        mutation_id: 'bad-title',
        entity_id: 'ticket-3',
        reason: 'set.title must be a string',
      },
      {
        mutation_id: 'bad-status',
        entity_id: 'ticket-4',
        reason: 'unknown status "unknown"',
      },
      {
        mutation_id: 'bad-priority',
        entity_id: 'ticket-priority',
        reason: 'unknown priority "critical"',
      },
      {
        mutation_id: 'bad-assignee',
        entity_id: 'ticket-assignee',
        reason: 'set.assignee must be a member id or null',
      },
      {
        mutation_id: 'read-only-timestamps',
        entity_id: 'ticket-timestamps',
        reason: 'created_at and updated_at are read-only',
      },
      {
        mutation_id: 'bad-base-seq',
        entity_id: 'ticket-5',
        reason: 'update requires a valid base_seq',
      },
    ])

    const agent = await json<{ token: string; metadata: { id: string } }>(
      worker,
      '/tokens',
      authenticated(adminToken, {
        name: 'test-agent',
        kind: 'agent',
        access: 'write',
      })
    )
    expect(agent.response.status).toBe(200)
    const duplicate = await json<{ error: string }>(
      worker,
      '/tokens',
      authenticated(adminToken, {
        name: 'TEST-AGENT',
        kind: 'agent',
        access: 'write',
      })
    )
    expect(duplicate.response.status).toBe(409)
    expect(duplicate.body.error).toBe('duplicate_token_name')
    const agentSnapshot = await json(worker, '/snapshot', authenticated(agent.body.token))
    expect(agentSnapshot.response.status).toBe(200)
    const revocation = await json(
      worker,
      '/tokens/revoke',
      authenticated(adminToken, { token_id: agent.body.metadata.id })
    )
    expect(revocation.response.status).toBe(200)
    const revokedSnapshot = await json(worker, '/snapshot', authenticated(agent.body.token))
    expect(revokedSnapshot.response.status).toBe(401)

    const githubSetup = await json<{ secret: string }>(
      worker,
      '/hooks/github/setup',
      authenticated(adminToken, {})
    )
    expect(githubSetup.response.status).toBe(200)
    const oversizedBody = ' '.repeat(1024 * 1024 + 1)
    const oversizedSignature = createHmac('sha256', githubSetup.body.secret)
      .update(oversizedBody)
      .digest('hex')
    const oversized = await json<{ error: string }>(worker, '/hooks/github', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-github-delivery': 'delivery-too-large',
        'x-hub-signature-256': `sha256=${oversizedSignature}`,
      },
      body: oversizedBody,
    })
    expect(oversized.response.status).toBe(413)
    expect(oversized.body.error).toBe('github_payload_too_large')
    const basePayload: GithubPayload = {
      action: 'closed',
      number: 7,
      pull_request: {
        number: 7,
        title: 'Fixes DEMO-2',
        body: null,
        merged: true,
        html_url: 'https://github.example/acme/repo/pull/7',
        base: { ref: 'main' },
      },
      repository: { full_name: 'acme/repo', default_branch: 'main' },
    }
    const invalidBody = structuredClone(basePayload)
    invalidBody.pull_request.body = 42
    const invalidDelivery = await json<{ error: string }>(
      worker,
      '/hooks/github',
      githubRequest(githubSetup.body.secret, 'delivery-invalid-body', invalidBody)
    )
    expect(invalidDelivery.response.status).toBe(400)
    expect(invalidDelivery.body.error).toBe('invalid_github_payload')

    const delivery = githubRequest(githubSetup.body.secret, 'delivery-7', basePayload)
    expect((await json(worker, '/hooks/github', delivery)).response.status).toBe(200)
    const afterMerge = await json<{
      tickets: Array<{ key: string; status: string }>
      latest_seq: number
    }>(worker, '/snapshot', authenticated(adminToken))
    expect(afterMerge.body.tickets.find((ticket) => ticket.key === 'DEMO-2')?.status).toBe('done')
    expect((await json(worker, '/hooks/github', delivery)).response.status).toBe(200)
    const afterReplay = await json<{ latest_seq: number }>(
      worker,
      '/snapshot',
      authenticated(adminToken)
    )
    expect(afterReplay.body.latest_seq).toBe(afterMerge.body.latest_seq)

    const reusedMutation = await json<{
      applied: Array<{ mutation_id: string; entity_id: string }>
      conflicts: Array<{
        mutation_id: string
        entity_id: string
        reason: string
      }>
    }>(
      worker,
      '/sync',
      authenticated(adminToken, {
        protocol_version: 2,
        last_seq: afterReplay.body.latest_seq,
        mutations: [
          {
            mutation_id: 'reused-in-one-request',
            op: 'create',
            entity: 'ticket',
            entity_id: '01JG4C8F3NZYXWVTSRQPNMKJHG',
            set: {
              project: '00000000000000000000000000',
              title: 'First use of the ID',
            },
          },
          {
            mutation_id: 'reused-in-one-request',
            op: 'create',
            entity: 'ticket',
            entity_id: '01JG4CBG4PZYXWVTSRQPNMKJHG',
            set: {
              project: '00000000000000000000000000',
              title: 'Different use of the ID',
            },
          },
        ],
      })
    )
    expect(reusedMutation.response.status).toBe(200)
    expect(reusedMutation.body.applied).toEqual([
      expect.objectContaining({
        mutation_id: 'reused-in-one-request',
        entity_id: '01JG4C8F3NZYXWVTSRQPNMKJHG',
      }),
    ])
    expect(reusedMutation.body.conflicts).toEqual([
      expect.objectContaining({
        mutation_id: 'reused-in-one-request',
        entity_id: '01JG4CBG4PZYXWVTSRQPNMKJHG',
        reason: 'mutation_id_reused',
      }),
    ])
  }, 30_000)
})
