import { describe, expect, test } from 'vitest'

import { isRoute } from '../src/routing'

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
})
