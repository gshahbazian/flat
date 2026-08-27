import { createHmac } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { unstable_dev, type Unstable_DevWorker } from 'wrangler'

const HMAC_KEY = Buffer.alloc(32, 27)
const SETUP_CREDENTIAL = `flat_setup_${Buffer.alloc(32, 29).toString('base64url')}`
const SETUP_VERIFIER = createHmac('sha256', HMAC_KEY).update(SETUP_CREDENTIAL).digest('hex')
const PROTOCOL_VERSION = 2
const TICKET_ID = '01KH2COMMENTTICKET000000001'
type WorkerRequestInit = NonNullable<Parameters<Unstable_DevWorker['fetch']>[1]>

interface JsonResponse<T> {
  status: number
  body: T
}

interface Comment {
  id: string
  ticket_id: string
  body: string
  member_id: string
  token_id: string
  token_kind: 'human' | 'agent'
  agent_name: string | null
  delegating_member_id: string | null
  seq: number
}

interface SyncResponse {
  applied: Array<{ mutation_id: string; entity_id: string; key: string; seq: number }>
  conflicts: Array<{ mutation_id: string; entity_id: string; reason: string }>
  deltas: Array<{ id: string; key: string; seq: number; updated_at: string }>
  comment_deltas: Comment[]
  latest_seq: number
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

async function enroll(
  worker: Unstable_DevWorker,
  adminToken: string,
  email: string,
  role: 'member' | 'viewer'
): Promise<{ id: string; token: string }> {
  const invitation = await json<{ invitation_code: string }>(
    worker,
    '/members/invite',
    authenticated(adminToken, { email, role })
  )
  expect(invitation.status).toBe(200)
  const enrollment = await json<{ member: { id: string }; token: string }>(
    worker,
    '/enroll/invite',
    {
      method: 'POST',
      body: JSON.stringify({
        credential: invitation.body.invitation_code,
        token_name: `${role}-cli`,
      }),
    }
  )
  expect(enrollment.status).toBe(200)
  return { id: enrollment.body.member.id, token: enrollment.body.token }
}

function sync(
  worker: Unstable_DevWorker,
  token: string,
  lastSeq: number,
  mutations: unknown[]
): Promise<JsonResponse<SyncResponse>> {
  return json(
    worker,
    '/sync',
    authenticated(token, {
      protocol_version: PROTOCOL_VERSION,
      last_seq: lastSeq,
      mutations,
    })
  )
}

function commentMutation(id: string, body: string, ticket = TICKET_ID): Record<string, unknown> {
  return {
    mutation_id: `mutation-${id}`,
    op: 'create',
    entity: 'comment',
    entity_id: id,
    set: { ticket, body },
  }
}

describe.sequential('comments', () => {
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

  test('syncs append-only comments with durable attribution and audit', async () => {
    const setup = await json<{
      token: string
      member: { id: string }
      snapshot: { latest_seq: number }
    }>(worker, '/setup', {
      method: 'POST',
      body: JSON.stringify({
        setup_credential: SETUP_CREDENTIAL,
        email: 'admin@example.com',
        tenant_name: 'Comments test',
        token_name: 'admin-cli',
      }),
    })
    expect(setup.status).toBe(200)
    const adminToken = setup.body.token
    const member = await enroll(worker, adminToken, 'member@example.com', 'member')
    const viewer = await enroll(worker, adminToken, 'viewer@example.com', 'viewer')

    const created = await sync(worker, adminToken, setup.body.snapshot.latest_seq, [
      {
        mutation_id: 'create-ticket',
        op: 'create',
        entity: 'ticket',
        entity_id: TICKET_ID,
        set: { project: '00000000000000000000000000', title: 'Comment target' },
      },
    ])
    expect(created.status).toBe(200)
    const ticket = created.body.deltas.find((candidate) => candidate.id === TICKET_ID)!

    const titleSearch = await json<{
      results: Array<{ key: string; match: { source: string } }>
    }>(worker, '/search', authenticated(adminToken, { query: 'comment target' }))
    expect(titleSearch.status).toBe(200)
    expect(titleSearch.body.results).toEqual([
      expect.objectContaining({
        key: 'DEMO-1',
        match: expect.objectContaining({ source: 'ticket' }),
      }),
    ])

    const selfAgent = await json<{ token: string }>(
      worker,
      '/tokens',
      authenticated(member.token, { name: 'claude', kind: 'agent', access: 'write' })
    )
    expect(selfAgent.status).toBe(200)
    const delegatedAgent = await json<{ token: string }>(
      worker,
      '/tokens',
      authenticated(adminToken, {
        name: 'ticket-triage',
        kind: 'agent',
        access: 'write',
        for_email: 'member@example.com',
      })
    )
    expect(delegatedAgent.status).toBe(200)

    const authorizedSearches = await Promise.all(
      [member.token, selfAgent.body.token, delegatedAgent.body.token].map((token) =>
        json<{ results: Array<{ key: string }> }>(
          worker,
          '/search',
          authenticated(token, { query: 'demo-1' })
        )
      )
    )
    for (const authorizedSearch of authorizedSearches) {
      expect(authorizedSearch.status).toBe(200)
      expect(authorizedSearch.body.results.map((result) => result.key)).toEqual(['DEMO-1'])
    }

    const invalidSearch = await json<{ error: string; offset: number }>(
      worker,
      '/search',
      authenticated(adminToken, { query: 'é status:working' })
    )
    expect(invalidSearch.status).toBe(422)
    expect(invalidSearch.body).toMatchObject({ error: 'invalid_search_query', offset: 10 })

    const humanMutation = commentMutation('comment-human', 'Human **Markdown**')
    const human = await sync(worker, member.token, created.body.latest_seq, [humanMutation])
    expect(human.status).toBe(200)
    expect(human.body.conflicts).toEqual([])
    expect(human.body.deltas).toEqual([
      expect.objectContaining({ id: TICKET_ID, seq: ticket.seq, updated_at: ticket.updated_at }),
    ])
    expect(human.body.comment_deltas).toEqual([
      expect.objectContaining({
        id: 'comment-human',
        member_id: member.id,
        token_kind: 'human',
        agent_name: null,
        delegating_member_id: null,
      }),
    ])

    const commentSearch = await json<{
      results: Array<{
        key: string
        match: { source: string; comment_id: string; excerpt: string }
      }>
    }>(worker, '/search', authenticated(viewer.token, { query: 'human markdown' }))
    expect(commentSearch.status).toBe(200)
    expect(commentSearch.body.results).toEqual([
      expect.objectContaining({
        key: 'DEMO-1',
        match: expect.objectContaining({ source: 'comment', comment_id: 'comment-human' }),
      }),
    ])

    const replay = await sync(worker, member.token, human.body.latest_seq, [humanMutation])
    expect(replay.body.applied).toEqual(human.body.applied)
    expect(replay.body.comment_deltas).toEqual([])

    const agent = await sync(worker, selfAgent.body.token, human.body.latest_seq, [
      commentMutation('comment-agent', 'Agent comment'),
    ])
    expect(agent.body.comment_deltas).toEqual([
      expect.objectContaining({
        id: 'comment-agent',
        member_id: member.id,
        token_kind: 'agent',
        agent_name: 'claude',
        delegating_member_id: null,
      }),
    ])

    const delegated = await sync(worker, delegatedAgent.body.token, agent.body.latest_seq, [
      commentMutation('comment-delegated', 'Delegated comment'),
    ])
    expect(delegated.body.comment_deltas).toEqual([
      expect.objectContaining({
        id: 'comment-delegated',
        member_id: member.id,
        token_kind: 'agent',
        agent_name: 'ticket-triage',
        delegating_member_id: setup.body.member.id,
      }),
    ])

    const viewerAttempt = await sync(worker, viewer.token, delegated.body.latest_seq, [
      commentMutation('comment-viewer', 'Not allowed'),
    ])
    expect(viewerAttempt.body.conflicts).toEqual([
      expect.objectContaining({ mutation_id: 'mutation-comment-viewer', reason: 'forbidden' }),
    ])

    const invalid = await sync(worker, member.token, delegated.body.latest_seq, [
      { ...commentMutation('comment-update', 'changed'), op: 'update', base_seq: 1 },
      { ...commentMutation('comment-delete', 'changed'), op: 'delete', base_seq: 1, set: {} },
      commentMutation('comment-empty', ' \n\t'),
      commentMutation('comment-unknown', 'body', 'unknown-ticket'),
      commentMutation('comment-large', 'a'.repeat(1024 * 1024 + 1)),
      {
        mutation_id: 'ticket-reserved-sentinel',
        op: 'update',
        entity: 'ticket',
        entity_id: TICKET_ID,
        base_seq: ticket.seq,
        set: { body: 'before\n<!-- flat:comments -->\nafter' },
      },
    ])
    expect(invalid.body.applied).toEqual([])
    expect(invalid.body.conflicts.map((conflict) => conflict.reason)).toEqual([
      'comments are append-only',
      'comments are append-only',
      'comment must not be empty',
      'unknown ticket unknown-ticket',
      'comment exceeds the 1048576-byte limit',
      'ticket body contains reserved comment sentinel',
    ])

    const snapshot = await json<{
      comments: Comment[]
      members: Array<{ id: string; status: string }>
    }>(worker, '/snapshot', authenticated(adminToken))
    expect(snapshot.status).toBe(200)
    expect(snapshot.body.comments.map((comment) => comment.id)).toEqual([
      'comment-human',
      'comment-agent',
      'comment-delegated',
    ])

    const audit = await json<{
      events: Array<{ action: string; metadata: Record<string, unknown> }>
    }>(worker, '/audit', authenticated(adminToken))
    const commentEvents = audit.body.events.filter((event) => event.action === 'comment.create')
    expect(commentEvents).toHaveLength(3)
    expect(JSON.stringify(commentEvents)).not.toContain('Human **Markdown**')

    const suspended = await json(
      worker,
      '/members/suspend',
      authenticated(adminToken, { email: 'member@example.com' })
    )
    expect(suspended.status).toBe(200)
    const historical = await json<{
      comments: Comment[]
      members: Array<{ id: string; status: string }>
    }>(worker, '/snapshot', authenticated(adminToken))
    expect(historical.body.comments).toHaveLength(3)
    expect(historical.body.members).toContainEqual(
      expect.objectContaining({ id: member.id, status: 'suspended' })
    )

    const deleted = await sync(worker, adminToken, delegated.body.latest_seq, [
      {
        mutation_id: 'delete-ticket',
        op: 'delete',
        entity: 'ticket',
        entity_id: TICKET_ID,
        base_seq: ticket.seq,
        set: {},
      },
    ])
    expect(deleted.body.conflicts).toEqual([])
    const afterDelete = await json<{ comments: Comment[] }>(
      worker,
      '/snapshot',
      authenticated(adminToken)
    )
    expect(afterDelete.body.comments).toEqual([])
    const afterDeleteSearch = await json<{ results: unknown[] }>(
      worker,
      '/search',
      authenticated(adminToken, { query: 'human markdown' })
    )
    expect(afterDeleteSearch.body.results).toEqual([])
  }, 30_000)
})
