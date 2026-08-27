import { describe, expect, test } from 'vitest'

import { readBoundedMcpBody } from '../src/mcp-body'
import { mcpLogLine } from '../src/mcp-log'
import { resolveMcpCorrelationId } from '../src/mcp-response'
import { MCP_MAX_REQUEST_BYTES } from '../src/mcp-schema'

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

  test('does not put unrecognized methods or tool names in logs', () => {
    const secret = 'forged\nlog-entry'
    const unknownTool = new TextEncoder().encode(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: secret, arguments: {} },
      })
    ).buffer
    const unknownMethod = new TextEncoder().encode(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: secret })
    ).buffer

    const toolLine = mcpLogLine('correlation-id', unknownTool, 404, 1, 100)
    const methodLine = mcpLogLine('correlation-id', unknownMethod, 404, 1, 100)
    expect(toolLine).toContain('operation=unknown_tool')
    expect(methodLine).toContain('operation=unknown_method')
    expect(toolLine).not.toContain(secret)
    expect(methodLine).not.toContain(secret)
  })

  test('preserves only valid Worker-generated correlation IDs', () => {
    const valid = '5b32e3a0-7407-48ff-872f-2ec42918877e'
    expect(resolveMcpCorrelationId(valid)).toBe(valid)
    expect(resolveMcpCorrelationId('attacker-controlled-value')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )
  })
})

describe('MCP request bodies', () => {
  test('cancels a streaming request as soon as it exceeds the byte limit', async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MCP_MAX_REQUEST_BYTES + 1))
      },
      cancel() {
        cancelled = true
      },
    })
    const request = new Request('https://flat.test/mcp', {
      method: 'POST',
      body: stream,
      duplex: 'half',
    })

    expect(await readBoundedMcpBody(request)).toBeNull()
    expect(cancelled).toBe(true)
  })
})
