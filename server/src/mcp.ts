import {
  McpServer,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
  type CallToolResult,
} from '@modelcontextprotocol/server'
import { createMcpHandler } from 'agents/mcp/server'

import type { Env } from './index'
import { mcpLogLine } from './mcp-log'
import {
  MCP_AUTH_PATH,
  MCP_CORRELATION_HEADER,
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
  mcpErrorResultFits,
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

async function jsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function rawErrorResult(error: McpErrorBody): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(error) }],
    structuredContent: error,
  }
}

function errorResult(error: McpErrorBody, correlationId: string): CallToolResult {
  if (mcpErrorResultFits(error)) return rawErrorResult(error)

  console.error('mcp error result exceeded size limit')
  return rawErrorResult({
    error: {
      category: 'internal',
      code: 'internal_error',
      message: 'The tool failed unexpectedly.',
      retryable: true,
      details: { correlation_id: correlationId },
    },
  })
}

function internalError(correlationId: string): CallToolResult {
  return errorResult(
    {
      error: {
        category: 'internal',
        code: 'internal_error',
        message: 'The tool failed unexpectedly.',
        retryable: true,
        details: { correlation_id: correlationId },
      },
    },
    correlationId
  )
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
        [MCP_CORRELATION_HEADER]: correlationId,
      },
      body: JSON.stringify(input),
    })
    const body = await jsonBody(response)
    if (!response.ok) {
      const parsedError = mcpErrorBodySchema.safeParse(body)
      if (parsedError.success) return errorResult(parsedError.data, correlationId)
      if (response.status === 401) {
        return errorResult(
          {
            error: {
              category: 'authentication',
              code: 'invalid_token',
              message: 'The current credential is no longer valid.',
              retryable: false,
            },
          },
          correlationId
        )
      }
      if (response.status === 403) {
        return errorResult(
          {
            error: {
              category: 'authorization',
              code: 'forbidden',
              message: 'The operation is not permitted.',
              retryable: false,
            },
          },
          correlationId
        )
      }
      return internalError(correlationId)
    }
    if (!mcpResultFits(body)) {
      return errorResult(
        {
          error: {
            category: 'validation',
            code: 'result_too_large',
            message: 'The complete result is too large to return.',
            retryable: false,
          },
        },
        correlationId
      )
    }

    if (!isJsonObject(body)) {
      return internalError(correlationId)
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(body) }],
      structuredContent: body,
    }
  } catch {
    console.error(`mcp executor failed correlation_id=${correlationId}`)
    return internalError(correlationId)
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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
        'Search accepted server ticket state with work.search permission. Local mirror edits are excluded. To list without full text, pass a filters-only query such as status:todo,in_progress or project:AUTH; an empty query is invalid. Results are summaries, so use get_ticket for full content.',
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
  const headerRejection = mcpHeaderRejection(request)
  if (headerRejection) return headerRejection

  const contentType = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase()
  if (contentType !== JSON_CONTENT_TYPE) return httpError(415, 'unsupported_media_type')

  const body = await boundedBody(request)
  if (body === null) return httpError(413, 'mcp_payload_too_large')

  const stub = env.TENANT.get(env.TENANT.idFromName('tenant'))
  const authorization = request.headers.get('Authorization') ?? ''
  const correlationId = crypto.randomUUID()
  const preflight = await stub.fetch(`https://tenant.invalid${MCP_AUTH_PATH}`, {
    method: 'POST',
    headers: { Authorization: authorization, [MCP_CORRELATION_HEADER]: correlationId },
  })
  if (!preflight.ok) return authenticationResponse(preflight)

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
    mcpLogLine(correlationId, body, response.status, performance.now() - startedAt, responseBytes)
  )
  return response
}

function mcpHeaderRejection(request: Request): Response | undefined {
  const requestUrl = new URL(request.url)
  const localHostnames = localhostAllowedHostnames()
  const localEndpoint = localHostnames.includes(requestUrl.hostname)
  const workersDevEndpoint = requestUrl.hostname.endsWith('.workers.dev')

  let allowedHostnames: string[] | undefined
  if (localEndpoint) allowedHostnames = localHostnames
  if (workersDevEndpoint) allowedHostnames = [requestUrl.hostname]

  if (allowedHostnames !== undefined) {
    const hostRejection = hostHeaderValidationResponse(request, allowedHostnames)
    if (hostRejection) return hostRejection
  }

  const allowedOriginHostnames = new Set(localhostAllowedOrigins())
  if (workersDevEndpoint) allowedOriginHostnames.add(requestUrl.hostname)
  return originValidationResponse(request, [...allowedOriginHostnames])
}
