import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

const serverUrl = required('FLAT_E2E_SERVER_URL')
const adminToken = required('FLAT_E2E_ADMIN_TOKEN')
const expectedKey = required('FLAT_E2E_EXPECTED_KEY')
const expectedTitle = required('FLAT_E2E_EXPECTED_TITLE')
const toolNames = [
  'add_comment',
  'create_ticket',
  'get_ticket',
  'list_assignable_members',
  'list_projects',
  'search_tickets',
  'update_ticket',
]

function required(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function api(path, token, body) {
  const response = await fetch(`${serverUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  const value = text ? JSON.parse(text) : null
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${JSON.stringify(value)}`)
  return value
}

async function connect(token, era) {
  const options = { supportedProtocolVersions: ['2025-11-25'] }
  if (era === 'modern') {
    options.supportedProtocolVersions = ['2026-07-28']
    options.versionNegotiation = { mode: { pin: '2026-07-28' } }
  } else {
    options.versionNegotiation = { mode: 'legacy' }
  }
  const client = new Client({ name: `flat-e2e-${era}`, version: '1.0.0' }, options)
  const transport = new StreamableHTTPClientTransport(new URL(`${serverUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  await client.connect(transport)
  return client
}

function receipt(result) {
  assert(result.isError !== true, `tool returned an error: ${JSON.stringify(result)}`)
  return result.structuredContent
}

const legacy = await connect(adminToken, 'legacy')
const listed = await legacy.listTools()
assert(
  JSON.stringify(listed.tools.map((tool) => tool.name).toSorted()) === JSON.stringify(toolNames),
  'legacy tool list did not contain exactly seven tools'
)

const accepted = receipt(
  await legacy.callTool({ name: 'get_ticket', arguments: { key: expectedKey } })
)
assert(accepted.ticket.title === expectedTitle, 'MCP observed an unpushed mirror edit')

const projects = receipt(await legacy.callTool({ name: 'list_projects', arguments: {} }))
assert(
  projects.projects.some((project) => project.key === 'DEMO'),
  'MCP omitted DEMO project'
)
const members = receipt(
  await legacy.callTool({ name: 'list_assignable_members', arguments: { query: 'member@' } })
)
assert(members.members.length === 1, 'MCP member discovery did not find the active member')

const created = receipt(
  await legacy.callTool({
    name: 'create_ticket',
    arguments: {
      idempotency_key: 'black-box-create',
      project: 'DEMO',
      title: 'MCP black-box ticket',
      assignee: 'member@example.com',
    },
  })
)
const replayed = receipt(
  await legacy.callTool({
    name: 'create_ticket',
    arguments: {
      idempotency_key: 'black-box-create',
      project: 'DEMO',
      title: 'MCP black-box ticket',
      body: '',
      status: 'todo',
      priority: 'none',
      assignee: 'member@example.com',
    },
  })
)
assert(
  replayed.replayed === true && replayed.seq === created.seq,
  'MCP create replay changed receipt'
)

const read = receipt(await legacy.callTool({ name: 'get_ticket', arguments: { key: created.key } }))
const updated = receipt(
  await legacy.callTool({
    name: 'update_ticket',
    arguments: {
      idempotency_key: 'black-box-update',
      key: created.key,
      base_seq: read.ticket.seq,
      set: { status: 'in_review' },
    },
  })
)
assert(updated.replayed === false, 'MCP update unexpectedly replayed')
const updateReplay = receipt(
  await legacy.callTool({
    name: 'update_ticket',
    arguments: {
      idempotency_key: 'black-box-update',
      key: created.key,
      base_seq: read.ticket.seq,
      set: { status: 'in_review' },
    },
  })
)
assert(updateReplay.replayed === true && updateReplay.seq === updated.seq, 'MCP update replay changed receipt')
const commented = receipt(
  await legacy.callTool({
    name: 'add_comment',
    arguments: {
      idempotency_key: 'black-box-comment',
      key: created.key,
      body: 'Black-box MCP comment',
    },
  })
)
assert(commented.key === created.key, 'MCP comment receipt used the wrong parent key')
const commentReplay = receipt(
  await legacy.callTool({
    name: 'add_comment',
    arguments: {
      idempotency_key: 'black-box-comment',
      key: created.key,
      body: 'Black-box MCP comment',
    },
  })
)
assert(
  commentReplay.replayed === true && commentReplay.seq === commented.seq,
  'MCP comment replay changed receipt'
)
const searched = receipt(
  await legacy.callTool({ name: 'search_tickets', arguments: { query: 'black-box mcp comment' } })
)
assert(
  searched.results.some((ticket) => ticket.key === created.key),
  'MCP search missed its comment'
)
await legacy.close()

const modern = await connect(adminToken, 'modern')
const modernTools = await modern.listTools()
assert(modernTools.tools.length === 7, 'modern tool discovery did not return seven tools')
receipt(await modern.callTool({ name: 'list_projects', arguments: {} }))
receipt(await modern.callTool({ name: 'list_assignable_members', arguments: {} }))
const modernCreated = receipt(
  await modern.callTool({
    name: 'create_ticket',
    arguments: {
      idempotency_key: 'black-box-modern-create',
      project: 'DEMO',
      title: 'Modern MCP black-box ticket',
    },
  })
)
const modernRead = receipt(
  await modern.callTool({ name: 'get_ticket', arguments: { key: modernCreated.key } })
)
receipt(
  await modern.callTool({
    name: 'update_ticket',
    arguments: {
      idempotency_key: 'black-box-modern-update',
      key: modernCreated.key,
      base_seq: modernRead.ticket.seq,
      set: { priority: 'high' },
    },
  })
)
receipt(
  await modern.callTool({
    name: 'add_comment',
    arguments: {
      idempotency_key: 'black-box-modern-comment',
      key: modernCreated.key,
      body: 'Modern MCP black-box comment',
    },
  })
)
const modernSearch = receipt(
  await modern.callTool({
    name: 'search_tickets',
    arguments: { query: 'modern mcp black-box ticket' },
  })
)
assert(
  modernSearch.results.some((ticket) => ticket.key === modernCreated.key),
  'modern MCP search missed its ticket'
)
await modern.close()

const invitation = await api('/members/invite', adminToken, {
  email: 'mcp-viewer@example.com',
  role: 'viewer',
})
const enrollment = await api('/enroll/invite', '', {
  credential: invitation.invitation_code,
  token_name: 'mcp-viewer',
})
const viewer = await connect(enrollment.token, 'legacy')
assert((await viewer.listTools()).tools.length === 7, 'viewer could not discover all tools')
const forbidden = await viewer.callTool({
  name: 'create_ticket',
  arguments: {
    idempotency_key: 'viewer-write',
    project: 'DEMO',
    title: 'Viewer write',
  },
})
assert(forbidden.isError === true, 'viewer MCP write unexpectedly succeeded')
await viewer.close()

const agent = await api('/tokens', adminToken, {
  name: 'mcp-black-box-agent',
  kind: 'agent',
  access: 'write',
})
const agentClient = await connect(agent.token, 'legacy')
assert((await agentClient.listTools()).tools.length === 7, 'agent could not discover MCP tools')
await agentClient.close()
await api('/tokens/revoke', adminToken, { token_id: agent.metadata.id })

let revoked = false
try {
  await connect(agent.token, 'legacy')
} catch {
  revoked = true
}
assert(revoked, 'revoked agent token still initialized MCP')
