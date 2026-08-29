import { createHmac } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { unstable_dev, type Unstable_DevWorker } from 'wrangler'

import type { JsonInputValue } from '../src/request-schema'

const HMAC_KEY = Buffer.alloc(32, 23)
const SETUP_CREDENTIAL = `flat_setup_${Buffer.alloc(32, 29).toString('base64url')}`
const SETUP_VERIFIER = createHmac('sha256', HMAC_KEY).update(SETUP_CREDENTIAL).digest('hex')
type WorkerRequestInit = NonNullable<Parameters<Unstable_DevWorker['fetch']>[1]>

interface Label {
  id: string
  name: string
  seq: number
}

interface Ticket {
  id: string
  key: string
  labels: string[]
  seq: number
}

interface SyncResponse {
  applied: Array<{ mutation_id: string; entity_id: string; key: string; seq: number }>
  conflicts: Array<{ mutation_id: string; entity_id: string; reason: string }>
  deltas: Ticket[]
  label_deltas: Label[]
  label_tombstones: Array<{ id: string; name: string; seq: number }>
  latest_seq: number
}

async function json<T>(
  worker: Unstable_DevWorker,
  path: string,
  init: WorkerRequestInit
): Promise<T> {
  const response = await worker.fetch(`http://flat.test${path}`, init)
  // SAFETY: Test callers supply the expected shape for endpoints they control.
  const body = (await response.json()) as T
  expect(response.status).toBe(200)
  return body
}

function authenticated(token: string, body?: JsonInputValue): WorkerRequestInit {
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
  role: 'member' | 'viewer'
): Promise<string> {
  const invitation = await json<{ invitation_code: string }>(
    worker,
    '/members/invite',
    authenticated(adminToken, { email, role })
  )
  const enrollment = await json<{ token: string }>(worker, '/enroll/invite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      credential: invitation.invitation_code,
      token_name: email.split('@')[0],
    }),
  })
  return enrollment.token
}

async function sync(
  worker: Unstable_DevWorker,
  token: string,
  lastSeq: number,
  mutations: JsonInputValue[]
): Promise<SyncResponse> {
  return json(
    worker,
    '/sync',
    authenticated(token, {
      protocol_version: 2,
      last_seq: lastSeq,
      mutations,
    })
  )
}

describe.sequential('labels', () => {
  let worker: Unstable_DevWorker
  let adminToken: string
  let memberToken: string
  let viewerToken: string
  let projectId: string

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
    const setup = await json<{
      token: string
      snapshot: { projects: Array<{ id: string; key: string }>; labels: Label[] }
    }>(worker, '/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        setup_credential: SETUP_CREDENTIAL,
        email: 'admin@example.com',
        tenant_name: 'Labels test',
        token_name: 'admin-cli',
      }),
    })
    if (setup.snapshot.labels.length !== 0) {
      throw new Error('setup returned unexpected labels')
    }
    adminToken = setup.token
    // SAFETY: Tenant setup always creates the DEMO project.
    projectId = setup.snapshot.projects.find((project) => project.key === 'DEMO')!.id
    memberToken = await enroll(worker, adminToken, 'member@example.com', 'member')
    viewerToken = await enroll(worker, adminToken, 'viewer@example.com', 'viewer')
  }, 30_000)

  afterAll(async () => {
    await worker.stop()
  })

  test('syncs label CRUD, commuting membership deltas, search, and tombstones', async () => {
    const created = await sync(worker, memberToken, 0, [
      {
        mutation_id: 'create-auth-label',
        entity: 'label',
        op: 'create',
        entity_id: 'label-auth',
        set: { name: ' Auth ' },
      },
      {
        mutation_id: 'create-bug-label',
        entity: 'label',
        op: 'create',
        entity_id: 'label-bug',
        set: { name: 'bug' },
      },
    ])
    expect(created.conflicts).toEqual([])
    expect(created.label_deltas.map((label) => label.name)).toEqual(['auth', 'bug'])
    const auth = created.label_deltas.find((label) => label.name === 'auth')!
    const bug = created.label_deltas.find((label) => label.name === 'bug')!

    const viewerDenied = await sync(worker, viewerToken, created.latest_seq, [
      {
        mutation_id: 'viewer-label-create',
        entity: 'label',
        op: 'create',
        entity_id: 'label-viewer',
        set: { name: 'viewer' },
      },
    ])
    expect(viewerDenied.conflicts[0]?.reason).toBe('forbidden')

    const ticketCreated = await sync(worker, memberToken, created.latest_seq, [
      {
        mutation_id: 'labeled-ticket-create',
        entity: 'ticket',
        op: 'create',
        entity_id: 'ticket-labeled',
        set: { project: projectId, title: 'Labeled ticket' },
        labels_add: [auth.id],
      },
      {
        mutation_id: 'unlabeled-ticket-create',
        entity: 'ticket',
        op: 'create',
        entity_id: 'ticket-unlabeled',
        set: { project: projectId, title: 'Unlabeled ticket' },
      },
    ])
    expect(ticketCreated.conflicts).toEqual([])
    const labeled = ticketCreated.deltas.find((ticket) => ticket.id === 'ticket-labeled')!
    expect(labeled.labels).toEqual([auth.id])

    const addBug = await sync(worker, memberToken, ticketCreated.latest_seq, [
      {
        mutation_id: 'add-bug',
        entity: 'ticket',
        op: 'update',
        entity_id: labeled.id,
        base_seq: labeled.seq,
        set: {},
        labels_add: [bug.id],
      },
    ])
    expect(addBug.conflicts).toEqual([])
    const removeAuth = await sync(worker, memberToken, addBug.latest_seq, [
      {
        mutation_id: 'remove-auth-stale-base',
        entity: 'ticket',
        op: 'update',
        entity_id: labeled.id,
        base_seq: labeled.seq,
        set: {},
        labels_remove: [auth.id],
      },
    ])
    expect(removeAuth.conflicts).toEqual([])
    expect(removeAuth.deltas.find((ticket) => ticket.id === labeled.id)?.labels).toEqual([bug.id])

    const bugSearch = await json<{ results: Array<{ key: string }> }>(
      worker,
      '/search',
      authenticated(viewerToken, { query: 'label:bug' })
    )
    expect(bugSearch.results.map((result) => result.key)).toEqual(['DEMO-1'])
    const noneSearch = await json<{ results: Array<{ key: string }> }>(
      worker,
      '/search',
      authenticated(viewerToken, { query: 'label:none' })
    )
    expect(noneSearch.results.map((result) => result.key)).toEqual(['DEMO-2'])

    const renamed = await sync(worker, memberToken, removeAuth.latest_seq, [
      {
        mutation_id: 'rename-bug',
        entity: 'label',
        op: 'update',
        entity_id: bug.id,
        base_seq: bug.seq,
        set: { name: 'defect' },
      },
    ])
    expect(renamed.conflicts).toEqual([])
    expect(renamed.label_deltas).toContainEqual(expect.objectContaining({ name: 'defect' }))
    expect(renamed.deltas).toContainEqual(
      expect.objectContaining({ id: labeled.id, labels: [bug.id] })
    )

    const reused = await sync(worker, memberToken, renamed.latest_seq, [
      {
        mutation_id: 'reuse-old-name',
        entity: 'label',
        op: 'create',
        entity_id: 'label-reused',
        set: { name: 'bug' },
      },
    ])
    expect(reused.conflicts[0]?.reason).toBe('label name bug is already used')

    const memberDelete = await sync(worker, memberToken, renamed.latest_seq, [
      {
        mutation_id: 'member-delete-label',
        entity: 'label',
        op: 'delete',
        entity_id: bug.id,
        base_seq: renamed.label_deltas.find((label) => label.id === bug.id)!.seq,
        set: {},
      },
    ])
    expect(memberDelete.conflicts[0]?.reason).toBe('forbidden')

    const deleted = await sync(worker, adminToken, renamed.latest_seq, [
      {
        mutation_id: 'admin-delete-label',
        entity: 'label',
        op: 'delete',
        entity_id: bug.id,
        base_seq: renamed.label_deltas.find((label) => label.id === bug.id)!.seq,
        set: {},
      },
    ])
    expect(deleted.conflicts).toEqual([])
    expect(deleted.label_tombstones).toEqual([
      expect.objectContaining({ id: bug.id, name: 'defect' }),
    ])
    expect(deleted.deltas.find((ticket) => ticket.id === labeled.id)?.labels).toEqual([])

    const reuseDeleted = await sync(worker, memberToken, deleted.latest_seq, [
      {
        mutation_id: 'reuse-deleted-name',
        entity: 'label',
        op: 'create',
        entity_id: 'label-reuse-deleted',
        set: { name: 'defect' },
      },
    ])
    expect(reuseDeleted.conflicts[0]?.reason).toBe('label name defect is already used')

    const snapshot = await json<{ labels: Label[]; tickets: Ticket[] }>(
      worker,
      '/snapshot',
      authenticated(viewerToken)
    )
    expect(snapshot.labels.map((label) => label.name)).toEqual(['auth'])
    expect(snapshot.tickets.find((ticket) => ticket.id === labeled.id)?.labels).toEqual([])
  })
})
