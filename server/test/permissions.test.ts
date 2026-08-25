import { describe, expect, test } from 'vitest'

import { may, roleCeiling, type Principal } from '../src/policy'
import { Role, TokenAccess, TokenKind } from '../src/schema.gen'
import { invalidEmail, invalidTenantName, invalidTokenName } from '../src/validate'

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    memberId: 'member-1',
    email: 'maya@acme.com',
    role: Role.Member,
    tokenId: 'token-1',
    tokenKind: TokenKind.Human,
    tokenName: 'maya-macbook',
    access: TokenAccess.Write,
    createdBy: 'member-1',
    ...overrides,
  }
}

describe('permission policy', () => {
  test('intersects role, token access, and token kind', () => {
    expect(may(principal(), 'ticket.update')).toBe(true)
    expect(may(principal({ role: Role.Viewer }), 'ticket.update')).toBe(false)
    expect(may(principal({ access: TokenAccess.Read }), 'ticket.update')).toBe(false)
    expect(may(principal({ role: Role.Admin, access: TokenAccess.Admin }), 'member.invite')).toBe(
      true
    )
    expect(
      may(principal({ role: Role.Admin, access: TokenAccess.Admin }), 'integration.github.manage')
    ).toBe(true)
    expect(may(principal(), 'integration.github.manage')).toBe(false)
    expect(
      may(
        principal({
          role: Role.Admin,
          access: TokenAccess.Admin,
          tokenKind: TokenKind.Agent,
        }),
        'member.invite'
      )
    ).toBe(false)
  })

  test('project owners and admins may manage project metadata', () => {
    expect(may(principal(), 'project.update', { ownerIds: ['member-1'] })).toBe(true)
    expect(may(principal(), 'project.update', { ownerIds: [] })).toBe(false)
    expect(
      may(principal({ role: Role.Admin, access: TokenAccess.Admin }), 'project.update', {
        ownerIds: [],
      })
    ).toBe(true)
  })

  test('role ceilings match the design', () => {
    expect(roleCeiling(Role.Viewer)).toBe(TokenAccess.Read)
    expect(roleCeiling(Role.Member)).toBe(TokenAccess.Write)
    expect(roleCeiling(Role.Admin)).toBe(TokenAccess.Admin)
  })
})
describe('permission validation', () => {
  test.each([
    [' Maya@Acme.COM ', 'maya@acme.com'],
    ['maya@sub.acme.com', 'maya@sub.acme.com'],
  ])('normalizes valid email %j', (email, expected) => {
    expect(invalidEmail(email)).toBe(expected)
  })

  test.each(['maya@acme', '@acme.com', 'a b@acme.com', 'a@@acme.com', 'a@.com', 'é@acme.com'])(
    'rejects invalid email %j',
    (email) => expect(invalidEmail(email)).toBeNull()
  )

  test('validates tenant and token names', () => {
    expect(invalidTenantName(' Acme ')).toBe('Acme')
    expect(invalidTenantName(' ')).toBeNull()
    expect(invalidTokenName('ticket-triage_1.test')).toBe(false)
    expect(invalidTokenName('bad name')).toBe(true)
    expect(invalidTokenName(`a${'b'.repeat(64)}`)).toBe(true)
  })
})
