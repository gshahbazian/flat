import { describe, expect, test } from 'vitest'

import { parseKeyRing } from '../src/crypto'
import {
  githubMergeTargetSchema,
  githubPayloadSchema,
  relevantGithubPullRequestSchema,
} from '../src/github'
import {
  bulkInvitationSchema,
  invitationSchema,
  setupBodySchema,
  setupIdentitySchema,
  socketAttachmentSchema,
  tokenCreateBodySchema,
} from '../src/request-schema'
import { Entity, MutationOp, Priority, Role, TokenKind } from '../src/schema.gen'
import {
  mutationInputSchema,
  mutationSchema,
  sequenceSchema,
  syncEnvelopeSchema,
} from '../src/wire-schema'

describe('wire schemas', () => {
  test('accepts the compatibility form of a create mutation', () => {
    const mutation = mutationInputSchema.parse({
      mutation_id: 'mutation-1',
      op: MutationOp.Create,
      entity: Entity.Ticket,
      entity_id: 'ticket-1',
      set: { title: 'Title', body: null, status: null },
      ignored: true,
    })

    expect(mutation).toEqual({
      mutation_id: 'mutation-1',
      op: MutationOp.Create,
      entity: Entity.Ticket,
      entity_id: 'ticket-1',
      set: { title: 'Title', body: undefined, status: undefined },
    })
    expect(mutationSchema.safeParse({ ...mutation, set: undefined }).success).toBe(false)
  })

  test('validates the sync envelope without rejecting individual mutations', () => {
    const result = syncEnvelopeSchema.parse({
      protocol_version: 1,
      last_seq: 0,
      mutations: [null, { mutation_id: 'bad' }],
    })

    expect(result.mutations).toHaveLength(2)
    expect(sequenceSchema.safeParse(-1).success).toBe(false)
    expect(sequenceSchema.safeParse(0x1_0000_0000).success).toBe(false)
  })

  test('preserves explicit assignment clears and validates priority', () => {
    const mutation = mutationInputSchema.parse({
      mutation_id: 'mutation-1',
      op: MutationOp.Update,
      entity: Entity.Ticket,
      entity_id: 'ticket-1',
      base_seq: 1,
      set: { priority: Priority.Urgent, assignee: null },
    })
    expect(mutation.set).toEqual({ priority: Priority.Urgent, assignee: null })
  })

  test('rejects client-supplied timestamps', () => {
    expect(
      mutationInputSchema.safeParse({
        mutation_id: 'mutation-1',
        op: MutationOp.Update,
        entity: Entity.Ticket,
        entity_id: 'ticket-1',
        base_seq: 1,
        set: { updated_at: '2026-08-25T12:34:56.000Z' },
      }).success
    ).toBe(false)
  })
})

describe('request schemas', () => {
  test('resolves setup aliases and normalizes identity fields', () => {
    const aliases = setupBodySchema.parse({
      credential: 'credential',
      admin_email: ' Admin@Example.com ',
      display_name: ' Example ',
      cli_name: ' workstation ',
    })

    expect(setupIdentitySchema.parse(aliases)).toEqual({
      email: 'admin@example.com',
      tenantName: 'Example',
      tokenName: 'workstation',
    })
  })

  test('normalizes bulk invitations before detecting duplicates', () => {
    const schema = bulkInvitationSchema(60, 120)
    expect(
      schema.safeParse({
        members: [{ email: 'A@example.com' }, { email: ' a@example.com ', role: Role.Admin }],
      }).success
    ).toBe(false)
  })

  test('preserves nullish enum defaults without defaulting null durations', () => {
    expect(invitationSchema(60, 120).parse({ email: 'user@example.com', role: null })).toEqual({
      email: 'user@example.com',
      role: Role.Member,
      expires_in_seconds: 60,
    })
    expect(tokenCreateBodySchema.parse({ name: 'agent', kind: null }).kind).toBe(TokenKind.Agent)
    expect(
      invitationSchema(60, 120).safeParse({
        email: 'user@example.com',
        expires_in_seconds: null,
      }).success
    ).toBe(false)
  })

  test('parses websocket attachments without accepting arbitrary shapes', () => {
    expect(socketAttachmentSchema.parse({ tokenId: 'token-1' })).toEqual({ tokenId: 'token-1' })
    expect(socketAttachmentSchema.safeParse({ tokenId: 1 }).success).toBe(false)
  })
})

describe('integration and configuration schemas', () => {
  test('parses only the GitHub fields the handler consumes', () => {
    const raw = {
      action: 'closed',
      number: 7,
      pull_request: {
        title: 'Fixes DEMO-1',
        body: null,
        merged: true,
        html_url: 'https://example.test/pull/7',
        base: { ref: 'main' },
      },
      repository: { full_name: 'acme/repo', default_branch: 'main' },
      sender: { ignored: true },
    }

    const payload = githubPayloadSchema.parse(raw)
    expect(githubMergeTargetSchema.safeParse(payload).success).toBe(true)
    expect(relevantGithubPullRequestSchema.parse(payload)).toEqual({
      pullNumber: 7,
      title: 'Fixes DEMO-1',
      body: null,
      url: 'https://example.test/pull/7',
      baseRef: 'main',
      repository: 'acme/repo',
      defaultBranch: 'main',
    })
  })

  test('validates HMAC key-ring entries with Zod', () => {
    expect(parseKeyRing('[{"id":"primary","secret":"secret"}]')).toEqual([
      { id: 'primary', secret: 'secret' },
    ])
    expect(() => parseKeyRing('[{"id":"primary","secret":1}]')).toThrow(
      'FLAT_HMAC_KEYS contains an invalid key'
    )
  })
})
