import { describe, expect, test } from 'vitest'

import { mcpLogLine } from '../src/mcp-log'
import { resolveMcpCorrelationId } from '../src/mcp-response'

describe('MCP logging', () => {
  test('records the tool name and metrics without arguments or result content', () => {
    const secret = 'do-not-log-this-query'
    const body = new TextEncoder().encode(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'search_tickets', arguments: { query: secret } },
      })
    ).buffer
    const line = mcpLogLine('correlation-id', body, 200, 12.6, 144)

    expect(line).toContain('operation=search_tickets')
    expect(line).toContain('method=POST route=/mcp')
    expect(line).toContain(`request_bytes=${body.byteLength} response_bytes=144`)
    expect(line).not.toContain(secret)
  })

  test('preserves only valid Worker-generated correlation IDs', () => {
    const valid = '5b32e3a0-7407-48ff-872f-2ec42918877e'
    expect(resolveMcpCorrelationId(valid)).toBe(valid)
    expect(resolveMcpCorrelationId('attacker-controlled-value')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
  })
})
