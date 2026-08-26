import { createHmac } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { unstable_dev, type Unstable_DevWorker } from 'wrangler'

const HMAC_KEY = Buffer.alloc(32, 17)
const SETUP_CREDENTIAL = `flat_setup_${Buffer.alloc(32, 19).toString('base64url')}`
const SETUP_VERIFIER = createHmac('sha256', HMAC_KEY).update(SETUP_CREDENTIAL).digest('hex')
type WorkerRequestInit = NonNullable<Parameters<Unstable_DevWorker['fetch']>[1]>
type Role = 'member' | 'viewer'

interface Member {
  id: string
  token: string
}

interface Project {
  id: string
  key: string
  display_name: string
  owner_ids: string[]
  seq: number
}

interface ProjectSyncResponse {
  applied: Array<{ mutation_id: string; entity_id: string; key: string; seq: number }>
  conflicts: Array<{ mutation_id: string; entity_id: string; reason: string }>
  project_deltas: Project[]
  project_tombstones: Array<{ id: string; key: string; seq: number }>
  latest_seq: number
}

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

function authenticated(token: string, body?: unknown): WorkerRequestInit {
  const headers = { Authorization: `Bearer ${token}` }
  if (body === undefined) return { headers }
  return {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

async function enroll(
  worker: Unstable_DevWorker,
  adminToken: string,
  email: string,
  role: Role = 'member'
): Promise<Member> {
  const invitation = await json<{ invitation_code: string }>(
    worker,
    '/members/invite',
    authenticated(adminToken, { email, role })
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

async function syncProjects(
  worker: Unstable_DevWorker,
  token: string,
  lastSeq: number,
  mutations: unknown[]
): Promise<ProjectSyncResponse> {
  return json<ProjectSyncResponse>(
    worker,
    '/sync',
    authenticated(token, {
      protocol_version: 2,
      last_seq: lastSeq,
      mutations,
    })
  )
}

async function createProject(
  worker: Unstable_DevWorker,
  token: string,
  key: string,
  entityId: string
): Promise<{ project: Project; response: ProjectSyncResponse }> {
  const response = await syncProjects(worker, token, 0, [
    {
      mutation_id: `create-${key.toLowerCase()}`,
      op: 'create',
      entity: 'project',
      entity_id: entityId,
      set: { key, display_name: `${key} project` },
    },
  ])
  expect(response.conflicts).toEqual([])
  const project = response.project_deltas.find((candidate) => candidate.key === key)
  expect(project).toBeDefined()
  return { project: project!, response }
}

describe.sequential('project mutations', () => {
  let worker: Unstable_DevWorker
  let setup: {
    member: { id: string }
    token: string
    snapshot: { latest_seq: number; projects: Project[] }
  }
  let owner: Member
  let collaborator: Member

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
    setup = await json(worker, '/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        setup_credential: SETUP_CREDENTIAL,
        email: 'admin@example.com',
        tenant_name: 'Projects test',
        token_name: 'admin-cli',
      }),
    })
    owner = await enroll(worker, setup.token, 'owner@example.com')
    collaborator = await enroll(worker, setup.token, 'collaborator@example.com')
  }, 30_000)

  afterAll(async () => {
    await worker.stop()
  })

  test('enforces ownership and project-scoped ticket counters', async () => {
    expect(setup.snapshot.projects).toEqual([
      expect.objectContaining({ key: 'DEMO', owner_ids: [setup.member.id] }),
    ])

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

  test('makes the effective member the owner when an agent creates a project', async () => {
    const agent = await json<{ token: string }>(
      worker,
      '/tokens',
      authenticated(owner.token, {
        name: 'project-agent',
        kind: 'agent',
        access: 'write',
      })
    )
    const { project } = await createProject(worker, agent.token, 'AGNT', 'project-agent-created')
    expect(project.owner_ids).toEqual([owner.id])
  })

  test('rejects viewer and pending project owners', async () => {
    const viewer = await enroll(worker, setup.token, 'viewer@example.com', 'viewer')
    await json(
      worker,
      '/members/invite',
      authenticated(setup.token, { email: 'pending-owner@example.com', role: 'member' })
    )
    const pendingMembers = await json<{
      members: Array<{ id: string; email: string }>
    }>(worker, '/members?pending=1', authenticated(setup.token))
    const pendingId = pendingMembers.members.find(
      (member) => member.email === 'pending-owner@example.com'
    )?.id
    expect(pendingId).toBeDefined()

    const { project } = await createProject(worker, owner.token, 'OWNR', 'project-owner-rules')
    const rejected = await syncProjects(worker, owner.token, 0, [
      {
        mutation_id: 'add-viewer-owner',
        op: 'update',
        entity: 'project',
        entity_id: project.id,
        base_seq: project.seq,
        set: {},
        owners_add: [viewer.id],
      },
      {
        mutation_id: 'add-pending-owner',
        op: 'update',
        entity: 'project',
        entity_id: project.id,
        base_seq: project.seq,
        set: {},
        owners_add: [pendingId],
      },
    ])
    expect(rejected.applied).toEqual([])
    expect(rejected.conflicts).toEqual([
      {
        mutation_id: 'add-viewer-owner',
        entity_id: project.id,
        reason: `owner ${viewer.id} must be an active member or admin`,
      },
      {
        mutation_id: 'add-pending-owner',
        entity_id: project.id,
        reason: `owner ${pendingId} must be an active member or admin`,
      },
    ])
  })

  test('allows an admin token to recover a project with no owners', async () => {
    const { project } = await createProject(worker, owner.token, 'ZERO', 'project-zero-owners')
    const removed = await syncProjects(worker, owner.token, 0, [
      {
        mutation_id: 'remove-final-owner',
        op: 'update',
        entity: 'project',
        entity_id: project.id,
        base_seq: project.seq,
        set: {},
        owners_remove: [owner.id],
      },
    ])
    expect(removed.conflicts).toEqual([])
    const ownerless = removed.project_deltas.find((candidate) => candidate.key === 'ZERO')
    expect(ownerless?.owner_ids).toEqual([])

    const adminWrite = await json<{ token: string }>(
      worker,
      '/tokens',
      authenticated(setup.token, {
        name: 'project-admin-write',
        kind: 'human',
        access: 'write',
      })
    )
    const denied = await syncProjects(worker, adminWrite.token, removed.latest_seq, [
      {
        mutation_id: 'write-token-recovery',
        op: 'update',
        entity: 'project',
        entity_id: project.id,
        base_seq: ownerless?.seq,
        set: {},
        owners_add: [owner.id],
      },
    ])
    expect(denied.conflicts).toEqual([
      {
        mutation_id: 'write-token-recovery',
        entity_id: project.id,
        reason: 'forbidden',
      },
    ])

    const recovered = await syncProjects(worker, setup.token, denied.latest_seq, [
      {
        mutation_id: 'admin-token-recovery',
        op: 'update',
        entity: 'project',
        entity_id: project.id,
        base_seq: ownerless?.seq,
        set: {},
        owners_add: [owner.id],
      },
    ])
    expect(recovered.conflicts).toEqual([])
    expect(recovered.project_deltas).toEqual([
      expect.objectContaining({ key: 'ZERO', owner_ids: [owner.id] }),
    ])
  })

  test('does not reuse a deleted project key', async () => {
    const { project, response } = await createProject(
      worker,
      owner.token,
      'USED',
      'project-used-once'
    )
    const deleted = await syncProjects(worker, setup.token, response.latest_seq, [
      {
        mutation_id: 'delete-used-project',
        op: 'delete',
        entity: 'project',
        entity_id: project.id,
        base_seq: project.seq,
        set: {},
      },
    ])
    expect(deleted.conflicts).toEqual([])
    expect(deleted.project_tombstones).toEqual([expect.objectContaining({ key: 'USED' })])

    const reused = await syncProjects(worker, owner.token, deleted.latest_seq, [
      {
        mutation_id: 'reuse-used-project',
        op: 'create',
        entity: 'project',
        entity_id: 'project-used-twice',
        set: { key: 'USED', display_name: 'Used again' },
      },
    ])
    expect(reused.applied).toEqual([])
    expect(reused.conflicts).toEqual([
      {
        mutation_id: 'reuse-used-project',
        entity_id: 'project-used-twice',
        reason: 'project key USED is already used',
      },
    ])
  })

  test('rejects stale overlapping project metadata edits', async () => {
    const { project } = await createProject(worker, owner.token, 'STAL', 'project-stale-edit')
    const first = await syncProjects(worker, owner.token, 0, [
      {
        mutation_id: 'first-project-name',
        op: 'update',
        entity: 'project',
        entity_id: project.id,
        base_seq: project.seq,
        set: { display_name: 'First name' },
      },
    ])
    expect(first.conflicts).toEqual([])

    const stale = await syncProjects(worker, owner.token, first.latest_seq, [
      {
        mutation_id: 'stale-project-name',
        op: 'update',
        entity: 'project',
        entity_id: project.id,
        base_seq: project.seq,
        set: { display_name: 'Second name' },
      },
    ])
    expect(stale.applied).toEqual([])
    expect(stale.conflicts).toEqual([
      expect.objectContaining({
        mutation_id: 'stale-project-name',
        entity_id: project.id,
        reason: expect.stringContaining('conflicting edits to display_name'),
      }),
    ])
  })
})
