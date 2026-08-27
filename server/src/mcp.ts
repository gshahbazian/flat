import { McpServer, type CallToolResult } from '@modelcontextprotocol/server'
import { createMcpHandler } from 'agents/mcp/server'

import type { Env } from './index'
import {
  MCP_AUTH_PATH,
  MCP_MAX_REQUEST_BYTES,
  MCP_PATH,
  addCommentInputSchema,
  createTicketInputSchema,
  getTicketInputSchema,
  getTicketOutputSchema,
  listAssignableMembersInputSchema,
  listAssignableMembersOutputSchema,
  listProjectsInputSchema,
  listProjectsOutputSchema,
  mcpErrorBodySchema,
  mcpResultFits,
  mcpToolPath,
  searchTicketsInputSchema,
  searchTicketsOutputSchema,
  updateTicketInputSchema,
  writeReceiptSchema,
  type McpErrorBody,
  type McpToolName,
} from './mcp-schema'

const JSON_CONTENT_TYPE = 'application/json'

function httpError(status: number, code: string, headers?: HeadersInit): Response {
  return Response.json({ error: code }, { status, headers })
}

async function boundedBody(request: Request): Promise<ArrayBuffer | null> {
  const declaredLength = Number(request.headers.get('Content-Length'))
  if (Number.isFinite(declaredLength) && declaredLength > MCP_MAX_REQUEST_BYTES) return null
  if (request.body === null) return new ArrayBuffer(0)

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  let tooLarge = false
  while (true) {
    // ReadableStream chunks have to be pulled in order.
    // oxlint-disable-next-line eslint/no-await-in-loop
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > MCP_MAX_REQUEST_BYTES) {
      tooLarge = true
      continue
    }
    chunks.push(value)
  }
  if (tooLarge) return null

  const body = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body.buffer
}

function requestWithBody(request: Request, body: ArrayBuffer): Request {
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
  })
}

function mcpOperation(body: ArrayBuffer): string {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(body))
    if (!value || typeof value !== 'object') return 'unknown'
    const message = value as { method?: unknown; params?: unknown }
    if (typeof message.method !== 'string') return 'unknown'
    if (message.method !== 'tools/call') return message.method
    if (!message.params || typeof message.params !== 'object') return message.method
    const name = (message.params as { name?: unknown }).name
    if (typeof name !== 'string') return message.method
    return name
  } catch {
    return 'malformed'
  }
}

async function jsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function errorResult(error: McpErrorBody): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(error) }],
    structuredContent: error,
  }
}

function internalError(correlationId: string): CallToolResult {
  return errorResult({
    error: {
      category: 'internal',
      code: 'internal_error',
      message: 'The tool failed unexpectedly.',
      retryable: true,
      details: { correlation_id: correlationId },
    },
  })
}

async function executeTool(
  stub: DurableObjectStub,
  authorization: string,
  tool: McpToolName,
  input: unknown,
  correlationId: string
): Promise<CallToolResult> {
  try {
    const response = await stub.fetch(`https://tenant.invalid${mcpToolPath(tool)}`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': JSON_CONTENT_TYPE,
        'X-Flat-Correlation-Id': correlationId,
      },
      body: JSON.stringify(input),
    })
    const body = await jsonBody(response)
    if (!response.ok) {
      const parsedError = mcpErrorBodySchema.safeParse(body)
      if (parsedError.success) return errorResult(parsedError.data)
      if (response.status === 401) {
        return errorResult({
          error: {
            category: 'authentication',
            code: 'invalid_token',
            message: 'The current credential is no longer valid.',
            retryable: false,
          },
        })
      }
      if (response.status === 403) {
        return errorResult({
          error: {
            category: 'authorization',
            code: 'forbidden',
            message: 'The operation is not permitted.',
            retryable: false,
          },
        })
      }
      return internalError(correlationId)
    }
    if (!mcpResultFits(body)) {
      return errorResult({
        error: {
          category: 'validation',
          code: 'result_too_large',
          message: 'The complete result is too large to return.',
          retryable: false,
        },
      })
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return internalError(correlationId)
    }
    const structuredContent = Object.fromEntries(Object.entries(body))
    return {
      content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
      structuredContent,
    }
  } catch {
    console.error(`mcp executor failed correlation_id=${correlationId}`)
    return internalError(correlationId)
  }
}

function createServer(
  stub: DurableObjectStub,
  authorization: string,
  correlationId: string
): McpServer {
  const server = new McpServer({ name: 'flat', version: '1.0.0' }, { capabilities: { tools: {} } })
  const readAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  }
  const createAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  }

  server.registerTool(
    'search_tickets',
    {
      description:
        'Search accepted server ticket state with work.search permission. Local mirror edits are excluded; results are summaries, so use get_ticket for full content.',
      inputSchema: searchTicketsInputSchema,
      outputSchema: searchTicketsOutputSchema,
      annotations: readAnnotations,
    },
    (input) => executeTool(stub, authorization, 'search_tickets', input, correlationId)
  )

  server.registerTool(
    'get_ticket',
    {
      description:
        'Read one ticket and ordered comments from accepted server state with work.read permission. Local mirror edits are excluded.',
      inputSchema: getTicketInputSchema,
      outputSchema: getTicketOutputSchema,
      annotations: readAnnotations,
    },
    (input) => executeTool(stub, authorization, 'get_ticket', input, correlationId)
  )

  server.registerTool(
    'list_projects',
    {
      description:
        'List exact project keys from accepted server state with work.read permission for deterministic ticket creation.',
      inputSchema: listProjectsInputSchema,
      outputSchema: listProjectsOutputSchema,
      annotations: readAnnotations,
    },
    (input) => executeTool(stub, authorization, 'list_projects', input, correlationId)
  )

  server.registerTool(
    'list_assignable_members',
    {
      description:
        'List active member emails from accepted server state with member.list permission for deterministic assignment.',
      inputSchema: listAssignableMembersInputSchema,
      outputSchema: listAssignableMembersOutputSchema,
      annotations: readAnnotations,
    },
    (input) => executeTool(stub, authorization, 'list_assignable_members', input, correlationId)
  )

  server.registerTool(
    'create_ticket',
    {
      description:
        'Create a ticket in accepted server state with ticket.create permission. Reuse the same idempotency_key only when retrying an identical uncertain request.',
      inputSchema: createTicketInputSchema,
      outputSchema: writeReceiptSchema,
      annotations: createAnnotations,
    },
    (input) => executeTool(stub, authorization, 'create_ticket', input, correlationId)
  )

  server.registerTool(
    'update_ticket',
    {
      description:
        'Update a ticket in accepted server state with ticket.update permission and a base_seq from get_ticket. Reuse the same idempotency_key only when retrying an identical uncertain request.',
      inputSchema: updateTicketInputSchema,
      outputSchema: writeReceiptSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input) => executeTool(stub, authorization, 'update_ticket', input, correlationId)
  )

  server.registerTool(
    'add_comment',
    {
      description:
        'Append a comment in accepted server state with comment.create permission. Reuse the same idempotency_key only when retrying an identical uncertain request.',
      inputSchema: addCommentInputSchema,
      outputSchema: writeReceiptSchema,
      annotations: createAnnotations,
    },
    (input) => executeTool(stub, authorization, 'add_comment', input, correlationId)
  )

  return server
}

function authenticationResponse(response: Response): Promise<Response> | Response {
  if (response.ok) return response
  if (response.status !== 401) return response

  const headers = new Headers(response.headers)
  headers.set('WWW-Authenticate', 'Bearer realm="flat"')
  return response
    .arrayBuffer()
    .then(
      (body) =>
        new Response(body, { status: response.status, statusText: response.statusText, headers })
    )
}

export async function handleMcpRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const contentType = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase()
  if (contentType !== JSON_CONTENT_TYPE) return httpError(415, 'unsupported_media_type')

  const body = await boundedBody(request)
  if (body === null) return httpError(413, 'mcp_payload_too_large')

  const stub = env.TENANT.get(env.TENANT.idFromName('tenant'))
  const authorization = request.headers.get('Authorization') ?? ''
  const preflight = await stub.fetch(`https://tenant.invalid${MCP_AUTH_PATH}`, {
    method: 'POST',
    headers: { Authorization: authorization },
  })
  if (!preflight.ok) return authenticationResponse(preflight)

  const correlationId = crypto.randomUUID()
  const operation = mcpOperation(body)
  const startedAt = performance.now()
  const handler = createMcpHandler(() => createServer(stub, authorization, correlationId), {
    route: MCP_PATH,
    legacy: 'stateless',
    responseMode: 'json',
    corsOptions: false,
    onerror: () => console.error(`mcp handler failed correlation_id=${correlationId}`),
  })
  const response = await handler(requestWithBody(request, body), env, ctx)
  response.headers.delete('Mcp-Session-Id')
  const responseBytes = (await response.clone().arrayBuffer()).byteLength
  console.log(
    `mcp correlation_id=${correlationId} operation=${operation} status=${response.status} duration_ms=${Math.round(performance.now() - startedAt)} request_bytes=${body.byteLength} response_bytes=${responseBytes}`
  )
  return response
}
