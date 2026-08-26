import { createHmac } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { unstable_dev, type Unstable_DevWorker } from 'wrangler'

const HMAC_KEY = Buffer.alloc(32, 17)
const SETUP_CREDENTIAL = `flat_setup_${Buffer.alloc(32, 19).toString('base64url')}`
const SETUP_VERIFIER = createHmac('sha256', HMAC_KEY).update(SETUP_CREDENTIAL).digest('hex')
type WorkerRequestInit = NonNullable<Parameters<Unstable_DevWorker['fetch']>[1]>

async function json<T>(
  worker: Unstable_DevWorker,
  path: string,
  init: WorkerRequestInit
): Promise<T> {
  const response = await worker.fetch(`http://flat.test${path}`, init)
  const body = (await response.json()) as T
  expect(response.status).toBe(200)
  return body
}

function authenticated(token: string, body: unknown): WorkerRequestInit {
  return {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }
}

async function enroll(
  worker: Unstable_DevWorker,
  adminToken: string,
  email: string
): Promise<{ id: string; token: string }> {
  const invitation = await json<{ invitation_code: string }>(
    worker,
    '/members/invite',
    authenticated(adminToken, { email, role: 'member' })
  )
  const enrollment = await json<{ member: { id: string }; token: string }>(
    worker,
    '/enroll/invite',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        credential: invitation.invitation_code,
        token_name: email.split('@')[0],
      }),
    }
  )
  return { id: enrollment.member.id, token: enrollment.token }
}

describe.sequential('project mutations', () => {
  let worker: Unstable_DevWorker

  beforeAll(async () => {
    worker = await unstable_dev('src/index.ts', {
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
  }, 30_000)

  afterAll(async () => {
    await worker.stop()
  })

  test('enforces ownership and project-scoped ticket counters', async () => {
    const setup = await json<{
      member: { id: string }
      token: string
      snapshot: { latest_seq: number; projects: Array<{ key: string; owner_ids: string[] }> }
    }>(worker, '/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        setup_credential: SETUP_CREDENTIAL,
        email: 'admin@example.com',
        tenant_name: 'Projects test',
        token_name: 'admin-cli',
      }),
    })
    expect(setup.snapshot.projects).toEqual([
      expect.objectContaining({ key: 'DEMO', owner_ids: [setup.member.id] }),
    ])

    const owner = await enroll(worker, setup.token, 'owner@example.com')
    const collaborator = await enroll(worker, setup.token, 'collaborator@example.com')

    const created = await json<{
      applied: Array<{ mutation_id: string; seq: number }>
      conflicts: unknown[]
      project_deltas: Array<{ id: string; key: string; owner_ids: string[]; seq: number }>
      latest_seq: number
    }>(
      worker,
      '/sync',
      authenticated(owner.token, {
        protocol_version: 2,
        last_seq: setup.snapshot.latest_seq,
        mutations: [
          {
            mutation_id: 'project-create',
            op: 'create',
            entity: 'project',
            entity_id: '01KH2PROJECT000000000000001',
            set: {
              key: 'AUTH',
              display_name: 'Authentication',
              description: 'Identity and access',
            },
          },
        ],
      })
    )
    expect(created.conflicts).toEqual([])
    const auth = created.project_deltas.find((project) => project.key === 'AUTH')
    expect(auth).toEqual(expect.objectContaining({ owner_ids: [owner.id] }))

    const denied = await json<{
      applied: unknown[]
      conflicts: Array<{ mutation_id: string; reason: string }>
    }>(
      worker,
      '/sync',
      authenticated(collaborator.token, {
        protocol_version: 2,
        last_seq: created.latest_seq,
        mutations: [
          {
            mutation_id: 'non-owner-update',
            op: 'update',
            entity: 'project',
            entity_id: auth?.id,
            base_seq: auth?.seq,
            set: { display_name: 'Not allowed' },
          },
        ],
      })
    )
    expect(denied.applied).toEqual([])
    expect(denied.conflicts).toEqual([
      { mutation_id: 'non-owner-update', reason: 'forbidden', entity_id: auth?.id },
    ])

    const ownerUpdate = await json<{
      conflicts: unknown[]
      project_deltas: Array<{ id: string; key: string; owner_ids: string[]; seq: number }>
      latest_seq: number
    }>(
      worker,
      '/sync',
      authenticated(owner.token, {
        protocol_version: 2,
        last_seq: created.latest_seq,
        mutations: [
          {
            mutation_id: 'owner-update',
            op: 'update',
            entity: 'project',
            entity_id: auth?.id,
            base_seq: auth?.seq,
            set: { display_name: 'Auth platform' },
            owners_add: [collaborator.id],
          },
        ],
      })
    )
    expect(ownerUpdate.conflicts).toEqual([])
    const updatedAuth = ownerUpdate.project_deltas.find((project) => project.key === 'AUTH')
    expect(updatedAuth?.owner_ids).toEqual([owner.id, collaborator.id].toSorted())

    const tickets = await json<{
      applied: Array<{ entity_id: string; key: string; seq: number }>
      conflicts: unknown[]
      latest_seq: number
    }>(
      worker,
      '/sync',
      authenticated(collaborator.token, {
        protocol_version: 2,
        last_seq: ownerUpdate.latest_seq,
        mutations: [
          {
            mutation_id: 'auth-ticket-one',
            op: 'create',
            entity: 'ticket',
            entity_id: '01KH2TICKET000000000000001',
            set: { project: auth?.id, title: 'First auth ticket' },
          },
          {
            mutation_id: 'auth-ticket-two',
            op: 'create',
            entity: 'ticket',
            entity_id: '01KH2TICKET000000000000002',
            set: { project: auth?.id, title: 'Second auth ticket' },
          },
        ],
      })
    )
    expect(tickets.conflicts).toEqual([])
    expect(tickets.applied.map((ticket) => ticket.key)).toEqual(['AUTH-1', 'AUTH-2'])

    await json(
      worker,
      '/members/role',
      authenticated(setup.token, {
        email: 'collaborator@example.com',
        role: 'viewer',
      })
    )
    const afterDemotion = await json<{
      project_deltas: Array<{ key: string; owner_ids: string[] }>
      latest_seq: number
    }>(
      worker,
      '/sync',
      authenticated(setup.token, {
        protocol_version: 2,
        last_seq: tickets.latest_seq,
        mutations: [],
      })
    )
    expect(afterDemotion.project_deltas).toEqual([
      expect.objectContaining({ key: 'AUTH', owner_ids: [owner.id] }),
    ])

    const nonEmptyDelete = await json<{
      conflicts: Array<{ mutation_id: string; reason: string }>
    }>(
      worker,
      '/sync',
      authenticated(setup.token, {
        protocol_version: 2,
        last_seq: afterDemotion.latest_seq,
        mutations: [
          {
            mutation_id: 'non-empty-project-delete',
            op: 'delete',
            entity: 'project',
            entity_id: auth?.id,
            base_seq: updatedAuth?.seq,
            set: {},
          },
        ],
      })
    )
    expect(nonEmptyDelete.conflicts[0].reason).toBe('project AUTH contains tickets')

    const removed = await json<{
      conflicts: unknown[]
      project_tombstones: Array<{ key: string }>
    }>(
      worker,
      '/sync',
      authenticated(setup.token, {
        protocol_version: 2,
        last_seq: afterDemotion.latest_seq,
        mutations: [
          ...tickets.applied.map((ticket, index) => ({
            mutation_id: `delete-ticket-${index}`,
            op: 'delete',
            entity: 'ticket',
            entity_id: ticket.entity_id,
            base_seq: ticket.seq,
            set: {},
          })),
          {
            mutation_id: 'empty-project-delete',
            op: 'delete',
            entity: 'project',
            entity_id: auth?.id,
            base_seq: updatedAuth?.seq,
            set: {},
          },
        ],
      })
    )
    expect(removed.conflicts).toEqual([])
    expect(removed.project_tombstones).toEqual([expect.objectContaining({ key: 'AUTH' })])
  })
})
