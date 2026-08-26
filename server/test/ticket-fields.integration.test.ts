import { createHmac } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { unstable_dev, type Unstable_DevWorker } from 'wrangler'

const HMAC_KEY = Buffer.alloc(32, 17)
const HMAC_SECRET = HMAC_KEY.toString('base64url')
const SETUP_CREDENTIAL = `flat_setup_${Buffer.alloc(32, 19).toString('base64url')}`
const SETUP_VERIFIER = createHmac('sha256', HMAC_KEY).update(SETUP_CREDENTIAL).digest('hex')
type WorkerRequestInit = NonNullable<Parameters<Unstable_DevWorker['fetch']>[1]>

interface Member {
  id: string
  email: string
  status: 'pending' | 'active' | 'suspended'
}

interface Ticket {
  id: string
  key: string
  title: string
  status: string
  priority: string
  assignee: string | null
  created_at: string
  updated_at: string
  seq: number
}

interface SyncResponse {
  applied: Array<{ mutation_id: string; entity_id: string; key: string; seq: number }>
  conflicts: Array<{ mutation_id: string; entity_id: string; reason: string }>
  deltas: Ticket[]
  members: Member[]
  latest_seq: number
}

interface JsonResponse<T> {
  status: number
  body: T
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
  const response = await worker.fetch(`http://flat.test${path}`, { ...init, headers })
  const text = await response.text()
  return { status: response.status, body: text ? (JSON.parse(text) as T) : (null as T) }
}

function authenticated(token: string, body?: unknown): WorkerRequestInit {
  const init: WorkerRequestInit = { headers: { Authorization: `Bearer ${token}` } }
  if (body !== undefined) {
    init.method = 'POST'
    init.body = JSON.stringify(body)
  }
  return init
}

function githubRequest(secret: string, delivery: string, key: string): WorkerRequestInit {
  const body = JSON.stringify({
    action: 'closed',
    number: 12,
    pull_request: {
      number: 12,
      title: `Fixes ${key}`,
      body: null,
      merged: true,
      html_url: 'https://github.example/acme/repo/pull/12',
      base: { ref: 'main' },
    },
    repository: { full_name: 'acme/repo', default_branch: 'main' },
  })
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

describe.sequential('ticket priority, assignment, and timestamps', () => {
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

  test('applies the complete ticket-field lifecycle', async () => {
    const setup = await json<{
      token: string
      member: Member
      snapshot: { latest_seq: number }
    }>(worker, '/setup', {
      method: 'POST',
      body: JSON.stringify({
        setup_credential: SETUP_CREDENTIAL,
        email: 'admin@example.com',
        tenant_name: 'Ticket field tests',
        token_name: 'admin-cli',
      }),
    })
    expect(setup.status).toBe(200)
    const adminToken = setup.body.token
    const adminId = setup.body.member.id

    const invitation = await json<{ invitation_code: string }>(
      worker,
      '/members/invite',
      authenticated(adminToken, { email: 'assigned@example.com', role: 'member' })
    )
    const enrollment = await json<{ member: Member }>(worker, '/enroll/invite', {
      method: 'POST',
      body: JSON.stringify({
        credential: invitation.body.invitation_code,
        token_name: 'assigned-cli',
      }),
    })
    const assignedId = enrollment.body.member.id

    await json(
      worker,
      '/members/invite',
      authenticated(adminToken, { email: 'pending@example.com', role: 'member' })
    )
    const pending = await json<{ members: Member[] }>(
      worker,
      '/members?pending=1',
      authenticated(adminToken)
    )
    const pendingId = pending.body.members.find(
      (member) => member.email === 'pending@example.com'
    )?.id
    expect(pendingId).toBeDefined()

    const create = await json<SyncResponse>(
      worker,
      '/sync',
      authenticated(adminToken, {
        protocol_version: 2,
        last_seq: 0,
        mutations: [
          {
            mutation_id: 'default-ticket',
            op: 'create',
            entity: 'ticket',
            entity_id: 'ticket-default',
            set: { project: '00000000000000000000000000', title: 'Default fields' },
          },
          {
            mutation_id: 'assigned-ticket',
            op: 'create',
            entity: 'ticket',
            entity_id: 'ticket-assigned',
            set: {
              project: '00000000000000000000000000',
              title: 'Assigned ticket',
              priority: 'high',
              assignee: assignedId,
            },
          },
          {
            mutation_id: 'missing-assignee',
            op: 'create',
            entity: 'ticket',
            entity_id: 'ticket-missing',
            set: {
              project: '00000000000000000000000000',
              title: 'Missing assignee',
              assignee: 'member-missing',
            },
          },
          {
            mutation_id: 'pending-assignee',
            op: 'create',
            entity: 'ticket',
            entity_id: 'ticket-pending',
            set: {
              project: '00000000000000000000000000',
              title: 'Pending assignee',
              assignee: pendingId,
            },
          },
        ],
      })
    )
    expect(create.body.conflicts).toEqual([
      expect.objectContaining({
        mutation_id: 'missing-assignee',
        reason: 'unknown assignee member-missing',
      }),
      expect.objectContaining({
        mutation_id: 'pending-assignee',
        reason: `assignee ${pendingId} is not active`,
      }),
    ])
    const defaultTicket = create.body.deltas.find((ticket) => ticket.id === 'ticket-default')
    const assignedTicket = create.body.deltas.find((ticket) => ticket.id === 'ticket-assigned')
    expect(defaultTicket).toMatchObject({ priority: 'none', assignee: null })
    expect(defaultTicket?.created_at).toBe(defaultTicket?.updated_at)
    expect(assignedTicket).toMatchObject({ priority: 'high', assignee: assignedId })

    const priorityUpdate = {
      mutation_id: 'priority-update',
      op: 'update',
      entity: 'ticket',
      entity_id: 'ticket-default',
      base_seq: defaultTicket?.seq,
      set: { priority: 'medium' },
    }
    const priority = await json<SyncResponse>(
      worker,
      '/sync',
      authenticated(adminToken, {
        protocol_version: 2,
        last_seq: 0,
        mutations: [priorityUpdate],
      })
    )
    const afterPriority = priority.body.deltas.find((ticket) => ticket.id === 'ticket-default')!
    expect(afterPriority.priority).toBe('medium')
    expect(afterPriority.updated_at > defaultTicket!.updated_at).toBe(true)

    const disjoint = await json<SyncResponse>(
      worker,
      '/sync',
      authenticated(adminToken, {
        protocol_version: 2,
        last_seq: 0,
        mutations: [
          {
            mutation_id: 'stale-disjoint-assignment',
            op: 'update',
            entity: 'ticket',
            entity_id: 'ticket-default',
            base_seq: defaultTicket?.seq,
            set: { assignee: adminId },
          },
        ],
      })
    )
    expect(disjoint.body.conflicts).toEqual([])
    const afterAssignment = disjoint.body.deltas.find((ticket) => ticket.id === 'ticket-default')!
    expect(afterAssignment).toMatchObject({ priority: 'medium', assignee: adminId })

    const reassign = await json<SyncResponse>(
      worker,
      '/sync',
      authenticated(adminToken, {
        protocol_version: 2,
        last_seq: 0,
        mutations: [
          {
            mutation_id: 'reassign',
            op: 'update',
            entity: 'ticket',
            entity_id: 'ticket-default',
            base_seq: afterAssignment.seq,
            set: { assignee: assignedId },
          },
        ],
      })
    )
    const afterReassign = reassign.body.deltas.find((ticket) => ticket.id === 'ticket-default')!
    expect(afterReassign.assignee).toBe(assignedId)

    await json(
      worker,
      '/members/suspend',
      authenticated(adminToken, { email: 'assigned@example.com' })
    )
    const suspendedSnapshot = await json<{ tickets: Ticket[]; members: Member[] }>(
      worker,
      '/snapshot',
      authenticated(adminToken)
    )
    expect(
      suspendedSnapshot.body.tickets.find((ticket) => ticket.id === 'ticket-default')?.assignee
    ).toBe(assignedId)
    expect(suspendedSnapshot.body.members).toContainEqual(
      expect.objectContaining({ id: assignedId, status: 'suspended' })
    )

    const rejectedSuspended = await json<SyncResponse>(
      worker,
      '/sync',
      authenticated(adminToken, {
        protocol_version: 2,
        last_seq: 0,
        mutations: [
          {
            mutation_id: 'suspended-assignee',
            op: 'update',
            entity: 'ticket',
            entity_id: 'ticket-assigned',
            base_seq: assignedTicket?.seq,
            set: { assignee: assignedId },
          },
        ],
      })
    )
    expect(rejectedSuspended.body.conflicts[0].reason).toBe(`assignee ${assignedId} is not active`)

    const clear = await json<SyncResponse>(
      worker,
      '/sync',
      authenticated(adminToken, {
        protocol_version: 2,
        last_seq: 0,
        mutations: [
          {
            mutation_id: 'clear-assignment',
            op: 'update',
            entity: 'ticket',
            entity_id: 'ticket-default',
            base_seq: afterReassign.seq,
            set: { assignee: null },
          },
        ],
      })
    )
    const afterClear = clear.body.deltas.find((ticket) => ticket.id === 'ticket-default')!
    expect(afterClear.assignee).toBeNull()

    const conflicting = await json<SyncResponse>(
      worker,
      '/sync',
      authenticated(adminToken, {
        protocol_version: 2,
        last_seq: 0,
        mutations: [
          {
            mutation_id: 'assignment-wins',
            op: 'update',
            entity: 'ticket',
            entity_id: 'ticket-default',
            base_seq: afterClear.seq,
            set: { assignee: adminId },
          },
          {
            mutation_id: 'stale-clear-conflicts',
            op: 'update',
            entity: 'ticket',
            entity_id: 'ticket-default',
            base_seq: afterClear.seq,
            set: { title: 'Must not apply', assignee: null },
          },
        ],
      })
    )
    expect(conflicting.body.conflicts).toEqual([
      expect.objectContaining({
        mutation_id: 'stale-clear-conflicts',
        reason: expect.stringContaining('conflicting edits to assignee'),
      }),
    ])
    const afterConflict = conflicting.body.deltas.find((ticket) => ticket.id === 'ticket-default')!
    expect(afterConflict.title).toBe('Default fields')
    const failedTimestamp = afterConflict.updated_at

    const failedOnly = await json<SyncResponse>(
      worker,
      '/sync',
      authenticated(adminToken, {
        protocol_version: 2,
        last_seq: 0,
        mutations: [
          {
            mutation_id: 'failed-only',
            op: 'update',
            entity: 'ticket',
            entity_id: 'ticket-default',
            base_seq: afterClear.seq,
            set: { assignee: null },
          },
        ],
      })
    )
    expect(failedOnly.body.conflicts[0].reason).toContain('conflicting edits to assignee')
    expect(
      failedOnly.body.deltas.find((ticket) => ticket.id === 'ticket-default')?.updated_at
    ).toBe(failedTimestamp)

    const priorityConflict = await json<SyncResponse>(
      worker,
      '/sync',
      authenticated(adminToken, {
        protocol_version: 2,
        last_seq: 0,
        mutations: [
          {
            mutation_id: 'priority-wins',
            op: 'update',
            entity: 'ticket',
            entity_id: 'ticket-default',
            base_seq: afterConflict.seq,
            set: { priority: 'urgent' },
          },
          {
            mutation_id: 'priority-conflicts',
            op: 'update',
            entity: 'ticket',
            entity_id: 'ticket-default',
            base_seq: afterConflict.seq,
            set: { title: 'Also must not apply', priority: 'low' },
          },
        ],
      })
    )
    expect(priorityConflict.body.conflicts[0].reason).toContain('conflicting edits to priority')
    const afterPriorityConflict = priorityConflict.body.deltas.find(
      (ticket) => ticket.id === 'ticket-default'
    )!
    expect(afterPriorityConflict.title).toBe('Default fields')
    expect(afterPriorityConflict.updated_at > failedTimestamp).toBe(true)

    const replayMutation = {
      mutation_id: 'idempotent-update',
      op: 'update',
      entity: 'ticket',
      entity_id: 'ticket-default',
      base_seq: afterPriorityConflict.seq,
      set: { title: 'Replayed once' },
    }
    const firstReplay = await json<SyncResponse>(
      worker,
      '/sync',
      authenticated(adminToken, {
        protocol_version: 2,
        last_seq: 0,
        mutations: [replayMutation],
      })
    )
    const afterFirstReplay = firstReplay.body.deltas.find(
      (ticket) => ticket.id === 'ticket-default'
    )!
    const secondReplay = await json<SyncResponse>(
      worker,
      '/sync',
      authenticated(adminToken, {
        protocol_version: 2,
        last_seq: 0,
        mutations: [replayMutation],
      })
    )
    expect(secondReplay.body.applied).toEqual(firstReplay.body.applied)
    expect(
      secondReplay.body.deltas.find((ticket) => ticket.id === 'ticket-default')?.updated_at
    ).toBe(afterFirstReplay.updated_at)

    const githubTicket = await json<SyncResponse>(
      worker,
      '/sync',
      authenticated(adminToken, {
        protocol_version: 2,
        last_seq: 0,
        mutations: [
          {
            mutation_id: 'github-ticket',
            op: 'create',
            entity: 'ticket',
            entity_id: 'ticket-github',
            set: { project: '00000000000000000000000000', title: 'Closed by GitHub' },
          },
        ],
      })
    )
    const beforeGithub = githubTicket.body.deltas.find((ticket) => ticket.id === 'ticket-github')!
    const githubSetup = await json<{ secret: string }>(
      worker,
      '/hooks/github/setup',
      authenticated(adminToken, {})
    )
    await json(
      worker,
      '/hooks/github',
      githubRequest(githubSetup.body.secret, 'ticket-fields-delivery', beforeGithub.key)
    )
    const afterGithub = await json<{ tickets: Ticket[] }>(
      worker,
      '/snapshot',
      authenticated(adminToken)
    )
    const closed = afterGithub.body.tickets.find((ticket) => ticket.id === 'ticket-github')!
    expect(closed.status).toBe('done')
    expect(closed.updated_at > beforeGithub.updated_at).toBe(true)
  }, 30_000)
})
