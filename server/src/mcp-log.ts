import { MCP_PATH, MCP_TOOLS, type McpToolName } from './mcp-schema'

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
    const value: unknown = JSON.parse(new TextDecoder().decode(body))
    if (!value || typeof value !== 'object') return 'unknown'
    const message = value as { method?: unknown; params?: unknown }
    if (typeof message.method !== 'string') return 'unknown'
    if (!MCP_PROTOCOL_METHODS.has(message.method)) return 'unknown_method'
    if (message.method !== 'tools/call') return message.method
    if (!message.params || typeof message.params !== 'object') return message.method
    const name = (message.params as { name?: unknown }).name
    if (typeof name !== 'string') return message.method
    if (!isMcpToolName(name)) return 'unknown_tool'
    return name
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
