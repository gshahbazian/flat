import { createHmac } from 'node:crypto'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { unstable_dev, type Unstable_DevWorker } from 'wrangler'

const HMAC_KEY = Buffer.alloc(32, 47)
const SETUP_CREDENTIAL = `flat_setup_${Buffer.alloc(32, 49).toString('base64url')}`
const SETUP_VERIFIER = createHmac('sha256', HMAC_KEY).update(SETUP_CREDENTIAL).digest('hex')
const MCP_URL = new URL('http://flat.test/mcp')
const TOOL_NAMES = [
  'add_comment',
  'create_ticket',
  'get_ticket',
  'list_assignable_members',
  'list_projects',
  'search_tickets',
  'update_ticket',
]
type WorkerRequestInit = NonNullable<Parameters<Unstable_DevWorker['fetch']>[1]>

async function json<T>(
  worker: Unstable_DevWorker,
  path: string,
  init: WorkerRequestInit = {},
  _type?: (value: unknown) => T
): Promise<{ response: Response; body: T }> {
  const response = (await worker.fetch(`http://flat.test${path}`, init)) as unknown as Response
  const text = await response.text()
  const body = text ? (JSON.parse(text) as T) : (null as T)
  return { response, body }
}

function mcpFetch(worker: Unstable_DevWorker): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init)
    const workerInit: WorkerRequestInit = {
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
    }
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.body !== null) {
      workerInit.body = await request.text()
    }
    const response = (await worker.fetch(request.url, workerInit)) as unknown as Response
    if (response.headers.has('Mcp-Session-Id')) throw new Error('MCP returned a session ID')
    return response
  }
}

async function connectClient(
  worker: Unstable_DevWorker,
  token: string,
  era: 'legacy' | 'modern'
): Promise<Client> {
  const options =
    era === 'legacy'
      ? {
          supportedProtocolVersions: ['2025-11-25'],
          versionNegotiation: { mode: 'legacy' as const },
        }
      : {
          supportedProtocolVersions: ['2026-07-28'],
          versionNegotiation: { mode: { pin: '2026-07-28' } },
        }
  const client = new Client({ name: `flat-${era}-test`, version: '1.0.0' }, options)
  const transport = new StreamableHTTPClientTransport(MCP_URL, {
    fetch: mcpFetch(worker),
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  await client.connect(transport)
  return client
}

async function enroll(
  worker: Unstable_DevWorker,
  adminToken: string,
  email: string,
  role: 'member' | 'viewer'
): Promise<{ id: string; token: string }> {
  const invitation = await json<{ invitation_code: string }>(worker, '/members/invite', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, role }),
  })
  const enrollment = await json<{ member: { id: string }; token: string }>(
    worker,
    '/enroll/invite',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        credential: invitation.body.invitation_code,
        token_name: `${role}-cli`,
      }),
    }
  )
  return { id: enrollment.body.member.id, token: enrollment.body.token }
}

describe.sequential('server-side MCP', () => {
  let worker: Unstable_DevWorker
  let adminToken: string
  let primaryTicketKey: string
  let primaryCreatedReceipt: Record<string, unknown>

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

  test('enforces exact transport routing before setup and authentication', async () => {
    const methods = ['GET', 'DELETE', 'OPTIONS']
    const responses = await Promise.all(
      methods.map((method) => worker.fetch('http://flat.test/mcp', { method }))
    )
    for (const response of responses) {
      expect(response.status).toBe(405)
      expect(response.headers.get('Allow')).toBe('POST')
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull()
    }
    expect((await worker.fetch('http://flat.test/mcp/extra', { method: 'POST' })).status).toBe(404)

    const beforeSetup = await json<{ error: string }>(worker, '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(beforeSetup.response.status).toBe(409)
    expect(beforeSetup.body).toEqual({ error: 'setup_required' })
  })

  test('authenticates and validates requests before protocol dispatch', async () => {
    const setup = await json<{ token: string }>(worker, '/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        setup_credential: SETUP_CREDENTIAL,
        email: 'admin@example.com',
        tenant_name: 'MCP test',
        token_name: 'admin-cli',
      }),
    })
    expect(setup.response.status).toBe(200)
    adminToken = setup.body.token

    const originProbe = await json<{ token: string; metadata: { id: string } }>(worker, '/tokens', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'origin-probe', kind: 'human', access: 'admin' }),
    })

    const missingToken = await json<{ error: string }>(worker, '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(missingToken.response.status).toBe(401)
    expect(missingToken.response.headers.get('WWW-Authenticate')).toBe('Bearer realm="flat"')
    expect(missingToken.body).toEqual({ error: 'invalid_token' })

    const wrongMediaType = await worker.fetch('http://flat.test/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'text/plain' },
      body: '{}',
    })
    expect(wrongMediaType.status).toBe(415)
    const oversized = await worker.fetch('http://flat.test/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify('x'.repeat(2 * 1024 * 1024)),
    })
    expect(oversized.status).toBe(413)
    const invalidOrigin = await worker.fetch('http://flat.test/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${originProbe.body.token}`,
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(invalidOrigin.status).toBe(403)
    const tokens = await json<{
      tokens: Array<{ id: string; last_used_at: string | null }>
    }>(worker, '/tokens?all=1', {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    expect(
      tokens.body.tokens.find((token) => token.id === originProbe.body.metadata.id)?.last_used_at
    ).toBeNull()
  })

  test('executes reads and writes through the legacy protocol era', async () => {
    const legacy = await connectClient(worker, adminToken, 'legacy')
    const legacyTools = await legacy.listTools()
    expect(legacyTools.tools.map((tool) => tool.name).toSorted()).toEqual(TOOL_NAMES)

    const projects = await legacy.callTool({ name: 'list_projects', arguments: {} })
    expect(projects.isError).not.toBe(true)
    expect(projects.structuredContent).toEqual({
      projects: [
        {
          id: '00000000000000000000000000',
          key: 'DEMO',
          display_name: 'Demo',
          description: '',
        },
      ],
      next_cursor: null,
    })
    expect(projects.content).toEqual([
      { type: 'text', text: JSON.stringify(projects.structuredContent) },
    ])
    const members = await legacy.callTool({
      name: 'list_assignable_members',
      arguments: { query: 'admin@' },
    })
    expect(members.structuredContent).toEqual({
      members: [expect.objectContaining({ email: 'admin@example.com', role: 'admin' })],
      next_cursor: null,
    })

    const created = await legacy.callTool({
      name: 'create_ticket',
      arguments: {
        idempotency_key: 'integration-create',
        project: 'demo',
        title: 'Created through MCP',
      },
    })
    expect(created.isError).not.toBe(true)
    expect(created.structuredContent).toEqual(
      expect.objectContaining({ key: 'DEMO-1', replayed: false })
    )
    const createdReceipt = created.structuredContent as Record<string, unknown>
    primaryCreatedReceipt = createdReceipt
    primaryTicketKey = String(createdReceipt.key)
    const replayed = await legacy.callTool({
      name: 'create_ticket',
      arguments: {
        idempotency_key: 'integration-create',
        project: 'DEMO',
        title: 'Created through MCP',
        body: '',
        status: 'todo',
        priority: 'none',
        assignee: null,
      },
    })
    expect(replayed.structuredContent).toEqual({
      ...createdReceipt,
      replayed: true,
    })
    const reused = await legacy.callTool({
      name: 'create_ticket',
      arguments: {
        idempotency_key: 'integration-create',
        project: 'DEMO',
        title: 'Different request',
      },
    })
    expect(reused.isError).toBe(true)
    expect(reused.structuredContent).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'idempotency_key_reused' }),
      })
    )

    const ticket = await legacy.callTool({
      name: 'get_ticket',
      arguments: { key: 'demo-1' },
    })
    expect(ticket.structuredContent).toEqual(
      expect.objectContaining({
        ticket: expect.objectContaining({ key: 'DEMO-1', title: 'Created through MCP' }),
        comments: [],
        next_comment_cursor: null,
      })
    )
    const ticketSeq = (ticket.structuredContent as { ticket: { seq: number } }).ticket.seq

    const updated = await legacy.callTool({
      name: 'update_ticket',
      arguments: {
        idempotency_key: 'integration-update',
        key: 'DEMO-1',
        base_seq: ticketSeq,
        set: { status: 'in_progress' },
      },
    })
    expect(updated.structuredContent).toEqual(
      expect.objectContaining({ key: 'DEMO-1', replayed: false })
    )
    const conflict = await legacy.callTool({
      name: 'update_ticket',
      arguments: {
        idempotency_key: 'integration-conflict',
        key: 'DEMO-1',
        base_seq: ticketSeq,
        set: { status: 'done' },
      },
    })
    expect(conflict.isError).toBe(true)
    expect(conflict.structuredContent).toEqual({
      error: {
        category: 'conflict',
        code: 'ticket_conflict',
        message: 'Ticket fields changed since the supplied base_seq.',
        retryable: true,
        details: { fields: ['status'], current_seq: expect.any(Number) },
      },
    })
    const disjoint = await legacy.callTool({
      name: 'update_ticket',
      arguments: {
        idempotency_key: 'integration-disjoint',
        key: 'DEMO-1',
        base_seq: ticketSeq,
        set: { assignee: 'admin@example.com' },
      },
    })
    expect(disjoint.isError).not.toBe(true)
    const disjointReceipt = disjoint.structuredContent as { seq: number }
    const cleared = await legacy.callTool({
      name: 'update_ticket',
      arguments: {
        idempotency_key: 'integration-clear-assignee',
        key: 'DEMO-1',
        base_seq: disjointReceipt.seq,
        set: { assignee: null },
      },
    })
    expect(cleared.isError).not.toBe(true)
    await legacy.close()
  })

  test('paginates comments at a stable watermark and supports filters-only search', async () => {
    const legacy = await connectClient(worker, adminToken, 'legacy')
    const commented = await legacy.callTool({
      name: 'add_comment',
      arguments: {
        idempotency_key: 'integration-comment',
        key: 'DEMO-1',
        body: 'Comment through MCP',
      },
    })
    expect(commented.structuredContent).toEqual(
      expect.objectContaining({ key: 'DEMO-1', replayed: false })
    )
    const commentReplay = await legacy.callTool({
      name: 'add_comment',
      arguments: {
        idempotency_key: 'integration-comment',
        key: 'demo-1',
        body: 'Comment through MCP',
      },
    })
    expect(commentReplay.structuredContent).toEqual({
      ...(commented.structuredContent as Record<string, unknown>),
      replayed: true,
    })
    await legacy.callTool({
      name: 'add_comment',
      arguments: {
        idempotency_key: 'integration-comment-two',
        key: 'DEMO-1',
        body: 'Second comment',
      },
    })
    const firstCommentPage = await legacy.callTool({
      name: 'get_ticket',
      arguments: { key: 'DEMO-1', comment_limit: 1 },
    })
    const firstPage = firstCommentPage.structuredContent as {
      comments: Array<{ body: string }>
      next_comment_cursor: string
    }
    expect(firstPage.comments).toEqual([expect.objectContaining({ body: 'Comment through MCP' })])
    expect(firstPage.next_comment_cursor).toEqual(expect.any(String))
    await legacy.callTool({
      name: 'add_comment',
      arguments: {
        idempotency_key: 'integration-comment-three',
        key: 'DEMO-1',
        body: 'Concurrent comment',
      },
    })
    const secondCommentPage = await legacy.callTool({
      name: 'get_ticket',
      arguments: {
        key: 'DEMO-1',
        comment_limit: 1,
        comment_cursor: firstPage.next_comment_cursor,
      },
    })
    expect(secondCommentPage.structuredContent).toEqual(
      expect.objectContaining({
        comments: [expect.objectContaining({ body: 'Second comment' })],
        next_comment_cursor: null,
      })
    )
    const search = await legacy.callTool({
      name: 'search_tickets',
      arguments: { query: 'comment through mcp' },
    })
    expect(search.structuredContent).toEqual(
      expect.objectContaining({ results: [expect.objectContaining({ key: 'DEMO-1' })] })
    )
    const filtersOnly = await legacy.callTool({
      name: 'search_tickets',
      arguments: { query: 'status:in_progress' },
    })
    expect(filtersOnly.structuredContent).toEqual(
      expect.objectContaining({ results: [expect.objectContaining({ key: 'DEMO-1' })] })
    )
    await legacy.close()
  })

  test('allows an authorized replacement token to replay the original receipt', async () => {
    const replacement = await json<{ token: string; metadata: { id: string } }>(worker, '/tokens', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'replacement', kind: 'human', access: 'admin' }),
    })
    const replacementClient = await connectClient(worker, replacement.body.token, 'legacy')
    const replacementReplay = await replacementClient.callTool({
      name: 'create_ticket',
      arguments: {
        idempotency_key: 'integration-create',
        project: 'DEMO',
        title: 'Created through MCP',
      },
    })
    expect(replacementReplay.structuredContent).toEqual({
      ...primaryCreatedReceipt,
      replayed: true,
    })
    await json(worker, '/tokens/revoke', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token_id: replacement.body.metadata.id }),
    })
    await expect(
      replacementClient.callTool({
        name: 'create_ticket',
        arguments: {
          idempotency_key: 'integration-create',
          project: 'DEMO',
          title: 'Created through MCP',
        },
      })
    ).rejects.toThrow(/invalid_token/)
    await replacementClient.close()
  })

  test('calls all seven tools through the modern protocol era', async () => {
    const modern = await connectClient(worker, adminToken, 'modern')
    const modernTools = await modern.listTools()
    expect(modernTools.tools.map((tool) => tool.name).toSorted()).toEqual(TOOL_NAMES)
    await modern.callTool({ name: 'list_projects', arguments: {} })
    await modern.callTool({ name: 'list_assignable_members', arguments: {} })
    const modernCreated = await modern.callTool({
      name: 'create_ticket',
      arguments: {
        idempotency_key: 'modern-create',
        project: 'DEMO',
        title: 'Modern protocol ticket',
      },
    })
    const modernKey = (modernCreated.structuredContent as { key: string }).key
    const modernRead = await modern.callTool({ name: 'get_ticket', arguments: { key: modernKey } })
    const modernSeq = (modernRead.structuredContent as { ticket: { seq: number } }).ticket.seq
    await modern.callTool({
      name: 'update_ticket',
      arguments: {
        idempotency_key: 'modern-update',
        key: modernKey,
        base_seq: modernSeq,
        set: { priority: 'high' },
      },
    })
    await modern.callTool({
      name: 'add_comment',
      arguments: {
        idempotency_key: 'modern-comment',
        key: modernKey,
        body: 'Modern protocol comment',
      },
    })
    const modernSearch = await modern.callTool({
      name: 'search_tickets',
      arguments: { query: 'modern protocol ticket' },
    })
    expect(modernSearch.structuredContent).toEqual(
      expect.objectContaining({ results: [expect.objectContaining({ key: modernKey })] })
    )
    await modern.close()
  })

  test('returns a bounded error when one complete result cannot fit', async () => {
    const snapshot = await json<{ latest_seq: number }>(worker, '/snapshot', {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    const oversizedBody = 'x'.repeat(2 * 1024 * 1024 + 1)
    const created = await json<{ applied: Array<{ key: string }> }>(worker, '/sync', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        protocol_version: 2,
        last_seq: snapshot.body.latest_seq,
        mutations: [
          {
            mutation_id: 'oversized-result-ticket',
            entity: 'ticket',
            op: 'create',
            entity_id: '01KMRESULTTOOLARGETICKET01',
            set: {
              project: '00000000000000000000000000',
              title: 'Oversized result',
              body: oversizedBody,
            },
          },
        ],
      }),
    })
    const client = await connectClient(worker, adminToken, 'legacy')
    const result = await client.callTool({
      name: 'get_ticket',
      arguments: { key: created.body.applied[0].key },
    })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toEqual(
      expect.objectContaining({ error: expect.objectContaining({ code: 'result_too_large' }) })
    )
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(
      16 * 1024
    )
    await client.close()
  })

  test('enforces permissions and reserves the MCP mutation namespace', async () => {
    const member = await enroll(worker, adminToken, 'member@example.com', 'member')
    const selfAgent = await json<{ token: string }>(worker, '/tokens', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${member.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'self-agent', kind: 'agent', access: 'write' }),
    })
    const delegatedAgent = await json<{ token: string }>(worker, '/tokens', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'delegated-agent',
        kind: 'agent',
        access: 'write',
        for_email: 'member@example.com',
      }),
    })

    const memberClient = await connectClient(worker, member.token, 'legacy')
    const selfAgentClient = await connectClient(worker, selfAgent.body.token, 'legacy')
    const delegatedAgentClient = await connectClient(worker, delegatedAgent.body.token, 'legacy')
    await memberClient.callTool({
      name: 'add_comment',
      arguments: {
        idempotency_key: 'member-human-comment',
        key: primaryTicketKey,
        body: 'Member human comment',
      },
    })
    await selfAgentClient.callTool({
      name: 'add_comment',
      arguments: {
        idempotency_key: 'self-agent-comment',
        key: primaryTicketKey,
        body: 'Self agent comment',
      },
    })
    await delegatedAgentClient.callTool({
      name: 'add_comment',
      arguments: {
        idempotency_key: 'delegated-agent-comment',
        key: primaryTicketKey,
        body: 'Delegated agent comment',
      },
    })
    await memberClient.close()
    await selfAgentClient.close()
    await delegatedAgentClient.close()

    const admin = await connectClient(worker, adminToken, 'legacy')
    const attributed = await admin.callTool({
      name: 'get_ticket',
      arguments: { key: primaryTicketKey },
    })
    const comments = (
      attributed.structuredContent as {
        comments: Array<{
          body: string
          author: {
            kind: string
            member: { email: string }
            agent_name: string | null
            delegated_by: { email: string } | null
          }
        }>
      }
    ).comments
    expect(comments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          body: 'Member human comment',
          author: expect.objectContaining({
            kind: 'human',
            member: expect.objectContaining({ email: 'member@example.com' }),
            agent_name: null,
            delegated_by: null,
          }),
        }),
        expect.objectContaining({
          body: 'Self agent comment',
          author: expect.objectContaining({
            kind: 'agent',
            member: expect.objectContaining({ email: 'member@example.com' }),
            agent_name: 'self-agent',
            delegated_by: null,
          }),
        }),
        expect.objectContaining({
          body: 'Delegated agent comment',
          author: expect.objectContaining({
            kind: 'agent',
            member: expect.objectContaining({ email: 'member@example.com' }),
            agent_name: 'delegated-agent',
            delegated_by: expect.objectContaining({ email: 'admin@example.com' }),
          }),
        }),
      ])
    )
    await admin.close()

    const invitation = await json<{ invitation_code: string }>(worker, '/members/invite', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email: 'viewer@example.com', role: 'viewer' }),
    })
    const enrollment = await json<{ token: string }>(worker, '/enroll/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        credential: invitation.body.invitation_code,
        token_name: 'viewer-cli',
      }),
    })
    const viewer = await connectClient(worker, enrollment.body.token, 'legacy')
    expect((await viewer.listTools()).tools.map((tool) => tool.name).toSorted()).toEqual(TOOL_NAMES)
    const forbidden = await viewer.callTool({
      name: 'create_ticket',
      arguments: {
        idempotency_key: 'viewer-create',
        project: 'DEMO',
        title: 'Viewer cannot create',
      },
    })
    expect(forbidden.isError).toBe(true)
    expect(forbidden.structuredContent).toEqual(
      expect.objectContaining({ error: expect.objectContaining({ code: 'forbidden' }) })
    )
    await viewer.close()

    const sync = await json<{
      applied: Array<{ mutation_id: string }>
      conflicts: Array<{ mutation_id: string; reason: string }>
    }>(worker, '/sync', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        protocol_version: 2,
        last_seq: 0,
        mutations: [
          {
            mutation_id: 'mcp:forged',
            entity: 'ticket',
            op: 'create',
            entity_id: '01KMFORGEDMCPMUTATION00001',
            set: { project: '00000000000000000000000000', title: 'Rejected' },
          },
          {
            mutation_id: 'ordinary-sync-mutation',
            entity: 'ticket',
            op: 'create',
            entity_id: '01KMVALIDSYNCMUTATION00001',
            set: { project: '00000000000000000000000000', title: 'Accepted' },
          },
        ],
      }),
    })
    expect(sync.body.conflicts).toContainEqual({
      mutation_id: 'mcp:forged',
      entity_id: '01KMFORGEDMCPMUTATION00001',
      reason: 'reserved_mutation_id',
    })
    expect(sync.body.applied).toContainEqual(
      expect.objectContaining({ mutation_id: 'ordinary-sync-mutation' })
    )
  }, 30_000)
})
