import { MCP_PATH, MCP_TOOLS, type McpToolName } from './mcp-schema'
import { jsonObjectSchema, stringValueSchema } from './request-schema'

const MCP_PROTOCOL_METHODS = new Set([
  'initialize',
  'notifications/cancelled',
  'notifications/initialized',
  'ping',
  'server/discover',
  'tools/call',
  'tools/list',
])

function isMcpToolName(value: string): value is McpToolName {
  return MCP_TOOLS.some((tool) => tool === value)
}

function mcpOperation(body: ArrayBuffer): string {
  try {
    const message = jsonObjectSchema.safeParse(JSON.parse(new TextDecoder().decode(body)))
    if (!message.success) return 'unknown'
    const method = stringValueSchema.safeParse(message.data.method)
    if (!method.success) return 'unknown'
    if (!MCP_PROTOCOL_METHODS.has(method.data)) return 'unknown_method'
    if (method.data !== 'tools/call') return method.data
    const params = jsonObjectSchema.safeParse(message.data.params)
    if (!params.success) return method.data
    const name = stringValueSchema.safeParse(params.data.name)
    if (!name.success) return method.data
    if (!isMcpToolName(name.data)) return 'unknown_tool'
    return name.data
  } catch {
    return 'malformed'
  }
}

export function mcpLogLine(
  correlationId: string,
  body: ArrayBuffer,
  status: number,
  durationMs: number,
  responseBytes: number
): string {
  const operation = mcpOperation(body)
  return `mcp correlation_id=${correlationId} method=POST route=${MCP_PATH} operation=${operation} status=${status} duration_ms=${Math.round(durationMs)} request_bytes=${body.byteLength} response_bytes=${responseBytes}`
}
