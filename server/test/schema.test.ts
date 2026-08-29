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
  tokenCreateBodySchema,
} from '../src/request-schema'
import { Entity, MutationOp, Priority, Role, Status, TokenKind } from '../src/schema.gen'
import { MAX_PROJECT_DESCRIPTION_BYTES } from '../src/validate'
import {
  mutationInputSchema,
  mutationSchema,
  sequenceSchema,
  snapshotSchema,
  syncEnvelopeSchema,
  syncResponseSchema,
  ticketSchema,
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
      protocol_version: 2,
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

  test('rejects oversized project descriptions', () => {
    const mutation = {
      mutation_id: 'mutation-1',
      op: MutationOp.Create,
      entity: Entity.Project,
      entity_id: 'project-1',
      set: {
        key: 'AUTH',
        display_name: 'Authentication',
        description: 'x'.repeat(MAX_PROJECT_DESCRIPTION_BYTES + 1),
      },
    }

    expect(mutationInputSchema.safeParse(mutation).success).toBe(false)
  })

  test('normalizes label mutations and validates ticket membership deltas', () => {
    const label = mutationInputSchema.parse({
      mutation_id: 'label-create',
      op: MutationOp.Create,
      entity: Entity.Label,
      entity_id: 'label-1',
      set: { name: ' Bug ' },
    })
    expect(label).toEqual(expect.objectContaining({ set: { name: 'bug' } }))
    expect(
      mutationInputSchema.safeParse({
        mutation_id: 'ticket-labels',
        op: MutationOp.Update,
        entity: Entity.Ticket,
        entity_id: 'ticket-1',
        base_seq: 1,
        set: {},
        labels_add: ['label-1'],
        labels_remove: ['label-2'],
      }).success
    ).toBe(true)
    expect(
      mutationInputSchema.safeParse({
        mutation_id: 'reserved-label',
        op: MutationOp.Create,
        entity: Entity.Label,
        entity_id: 'label-2',
        set: { name: 'none' },
      }).success
    ).toBe(false)
  })

  test('defaults additive label fields from pre-label payloads', () => {
    const rawTicket = {
      id: 'ticket-1',
      key: 'DEMO-1',
      project: 'project-1',
      title: 'Old payload',
      body: '',
      status: Status.Todo,
      priority: Priority.None,
      assignee: null,
      created_at: '2026-08-25T12:34:56.000Z',
      updated_at: '2026-08-25T12:34:56.000Z',
      seq: 1,
    }
    expect(ticketSchema.parse(rawTicket).labels).toEqual([])

    const response = syncResponseSchema.parse({
      applied: [],
      conflicts: [],
      deltas: [rawTicket],
      comment_deltas: [],
      latest_seq: 1,
    })
    expect(response.label_deltas).toEqual([])
    expect(response.label_tombstones).toEqual([])
    expect(response.deltas[0].labels).toEqual([])

    const snapshot = snapshotSchema.parse({
      projects: [],
      tickets: [rawTicket],
      comments: [],
      latest_seq: 1,
    })
    expect(snapshot.labels).toEqual([])
    expect(snapshot.tickets[0].labels).toEqual([])
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
