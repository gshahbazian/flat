import { MCP_PATH } from './mcp-schema'

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
