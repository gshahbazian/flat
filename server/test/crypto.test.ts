import { describe, expect, test } from 'vitest'

import {
  canonicalSha256,
  createCredential,
  parseCredential,
} from '../src/crypto'

describe('credential format', () => {
  test('round-trips a generated token credential', () => {
    const token = createCredential('flat_pat')
    expect(token.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(parseCredential(token.credential, 'flat_pat')).toEqual({
      id: token.id,
      secret: token.secret,
    })
  })

  test('parses positionally even when the secret contains underscores', () => {
    const id = '01K00000000000000000000000'
    const secret = `${'A'.repeat(42)}_A`
    expect(parseCredential(`flat_inv_${id}_${secret}`, 'flat_inv')).toEqual({
      id,
      secret,
    })
  })

  test.each([
    'flat_pat_short_secret',
    `flat_pat_${'I'.repeat(26)}_${'A'.repeat(43)}`,
    `flat_inv_01K00000000000000000000000_${'A'.repeat(43)}`,
  ])('rejects malformed token %j', (credential) => {
    expect(parseCredential(credential, 'flat_pat')).toBeNull()
  })
})
describe('canonical mutation hashing', () => {
  test('ignores object insertion order and omitted undefined fields', async () => {
    const first = {
      mutation_id: 'm',
      op: 'update',
      entity: 'ticket',
      entity_id: 't',
      set: { status: 'done' },
    }
    const second = {
      set: { status: 'done', body: undefined },
      entity_id: 't',
      entity: 'ticket',
      op: 'update',
      mutation_id: 'm',
      base_seq: undefined,
    }
    expect(await canonicalSha256(first)).toBe(await canonicalSha256(second))
  })
})
