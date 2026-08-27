import type { McpErrorCategory, McpErrorDetail } from './mcp-schema'

const CORRELATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function mcpError(
  status: number,
  category: McpErrorCategory,
  code: string,
  message: string,
  retryable = false,
  details?: Record<string, unknown>
): Response {
  const error: McpErrorDetail = { category, code, message, retryable }
  if (details !== undefined) error.details = details
  return Response.json({ error }, { status })
}

export function resolveMcpCorrelationId(value: string | null): string {
  if (value !== null && CORRELATION_ID_PATTERN.test(value)) return value
  return crypto.randomUUID()
}
