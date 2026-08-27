import { MCP_MAX_REQUEST_BYTES } from './mcp-schema'

export async function readBoundedMcpBody(request: Request): Promise<ArrayBuffer | null> {
  const declaredLength = Number(request.headers.get('Content-Length'))
  if (Number.isFinite(declaredLength) && declaredLength > MCP_MAX_REQUEST_BYTES) {
    await request.body?.cancel().catch(() => {})
    return null
  }
  if (request.body === null) return new ArrayBuffer(0)

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    // ReadableStream chunks have to be pulled in order.
    // oxlint-disable-next-line eslint/no-await-in-loop
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > MCP_MAX_REQUEST_BYTES) {
      void reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }

  const body = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body.buffer
}
