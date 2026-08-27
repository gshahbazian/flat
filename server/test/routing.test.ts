import { describe, expect, test } from 'vitest'

import { isMcpPath, isRoute } from '../src/routing'

describe('Worker route matching', () => {
  test('exposes only the exact GitHub delivery path', () => {
    expect(isRoute('POST', '/hooks/github')).toBe(true)
    expect(isRoute('GET', '/hooks/github')).toBe(false)
    expect(isRoute('POST', '/hooks/github/extra')).toBe(false)
  })

  test('keeps GitHub setup as a distinct routed endpoint', () => {
    expect(isRoute('POST', '/hooks/github/setup')).toBe(true)
    expect(isRoute('POST', '/hooks/github/setup/rotate')).toBe(false)
  })

  test('routes search only as an exact POST endpoint', () => {
    expect(isRoute('POST', '/search')).toBe(true)
    expect(isRoute('GET', '/search')).toBe(false)
    expect(isRoute('POST', '/search/extra')).toBe(false)
  })

  test('matches only the exact MCP pathname outside the ordinary allowlist', () => {
    expect(isMcpPath('/mcp')).toBe(true)
    expect(isMcpPath('/mcp/extra')).toBe(false)
    expect(isRoute('POST', '/mcp')).toBe(false)
  })
})
