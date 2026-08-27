import { describe, expect, test } from 'vitest'

import {
  addCommentInputSchema,
  createTicketInputSchema,
  decodeMcpCursor,
  encodeMcpCursor,
  getTicketInputSchema,
  listAssignableMembersInputSchema,
  updateTicketInputSchema,
} from '../src/mcp-schema'

describe('MCP tool schemas', () => {
  test('normalizes defaults, keys, titles, and emails before writes are hashed', () => {
    expect(
      createTicketInputSchema.parse({
        idempotency_key: 'run-1',
        project: 'auth',
        title: '  Fix login  ',
        assignee: ' USER@EXAMPLE.COM ',
      })
    ).toEqual({
      idempotency_key: 'run-1',
      project: 'AUTH',
      title: 'Fix login',
      body: '',
      status: 'todo',
      priority: 'none',
      assignee: 'user@example.com',
    })
  })

  test('rejects unknown and caller-controlled identity fields', () => {
    const base = {
      idempotency_key: 'run-1',
      project: 'AUTH',
      title: 'Fix login',
    }
    expect(createTicketInputSchema.safeParse({ ...base, actor_member_id: 'member' }).success).toBe(
      false
    )
    expect(createTicketInputSchema.safeParse({ ...base, token_id: 'token' }).success).toBe(false)
    expect(createTicketInputSchema.safeParse({ ...base, agent_name: 'agent' }).success).toBe(false)
  })

  test('requires a nonempty strict update set and a valid sequence', () => {
    const base = { idempotency_key: 'run-2', key: 'auth-1', base_seq: 4 }
    expect(updateTicketInputSchema.safeParse({ ...base, set: {} }).success).toBe(false)
    expect(updateTicketInputSchema.safeParse({ ...base, set: { status: 'done' } }).success).toBe(
      true
    )
    expect(
      updateTicketInputSchema.safeParse({ ...base, base_seq: -1, set: { status: 'done' } }).success
    ).toBe(false)
    expect(
      updateTicketInputSchema.safeParse({ ...base, set: { status: 'done', project: 'OTHER' } })
        .success
    ).toBe(false)
  })

  test('enforces comment, member-query, and page limits', () => {
    expect(
      addCommentInputSchema.safeParse({ idempotency_key: 'run-3', key: 'AUTH-1', body: '   ' })
        .success
    ).toBe(false)
    expect(listAssignableMembersInputSchema.safeParse({ query: 'x'.repeat(257) }).success).toBe(
      false
    )
    expect(getTicketInputSchema.safeParse({ key: 'AUTH-1', comment_limit: 101 }).success).toBe(
      false
    )
  })

  test('round-trips opaque UTF-8 cursors and rejects malformed encoding', () => {
    const value = { kind: 'members', query: 'gábe', last_email: 'gabe@example.com' }
    expect(decodeMcpCursor(encodeMcpCursor(value))).toEqual(value)
    expect(decodeMcpCursor('%%%')).toBeNull()
  })
})
