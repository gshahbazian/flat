// Round-trips every schema fixture through the generated TypeScript types:
// parse the JSON into a typed value field-by-field (rejecting wrong types and
// unknown fields), then require the typed value to deep-equal the fixture.
// The Rust twin of this test is schema/tests/fixtures.rs.
import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'vitest'
import { z } from 'zod'

import { canonicalJson } from '../src/crypto'
import { jsonValueSchema, type JsonValue } from '../src/request-schema'
import {
  invalidCommentBody,
  invalidEmail,
  invalidProjectDescription,
  invalidTicketBody,
  invalidTitle,
  labelNameSchema,
  MAX_COMMENT_BYTES,
  MAX_PROJECT_DESCRIPTION_BYTES,
} from '../src/validate'
import {
  commentSchema,
  labelSchema,
  mutationSchema,
  projectSchema,
  searchErrorDetailSchema,
  searchRequestSchema,
  searchResponseSchema,
  snapshotSchema,
  syncRequestSchema,
  syncResponseSchema,
  ticketSchema,
} from '../src/wire-schema'

function fixture(name: string): JsonValue {
  return jsonValueSchema.parse(
    JSON.parse(readFileSync(new URL(`../../schema/fixtures/${name}.json`, import.meta.url), 'utf8'))
  )
}

describe('schema fixtures round-trip through the generated types', () => {
  test('ticket', () => {
    expect(ticketSchema.parse(fixture('ticket'))).toEqual(fixture('ticket'))
  })

  test('comment', () => {
    expect(commentSchema.parse(fixture('comment'))).toEqual(fixture('comment'))
  })

  test('project', () => {
    expect(projectSchema.parse(fixture('project'))).toEqual(fixture('project'))
  })

  test('label', () => {
    expect(labelSchema.parse(fixture('label'))).toEqual(fixture('label'))
  })

  test('mutation', () => {
    expect(mutationSchema.parse(fixture('mutation'))).toEqual(fixture('mutation'))
  })

  test('project mutation', () => {
    expect(mutationSchema.parse(fixture('project_mutation'))).toEqual(fixture('project_mutation'))
  })

  test('comment mutation', () => {
    expect(mutationSchema.parse(fixture('comment_mutation'))).toEqual(fixture('comment_mutation'))
  })

  test('label mutation', () => {
    expect(mutationSchema.parse(fixture('label_mutation'))).toEqual(fixture('label_mutation'))
  })

  test('sync_request', () => {
    expect(syncRequestSchema.parse(fixture('sync_request'))).toEqual(fixture('sync_request'))
  })

  test('sync_response', () => {
    expect(syncResponseSchema.parse(fixture('sync_response'))).toEqual(fixture('sync_response'))
  })

  test('snapshot', () => {
    expect(snapshotSchema.parse(fixture('snapshot'))).toEqual(fixture('snapshot'))
  })

  test('search request', () => {
    expect(searchRequestSchema.parse(fixture('search_request'))).toEqual(fixture('search_request'))
  })

  test('search response', () => {
    expect(searchResponseSchema.parse(fixture('search_response'))).toEqual(
      fixture('search_response')
    )
  })

  test('search error detail', () => {
    expect(searchErrorDetailSchema.parse(fixture('search_error_detail'))).toEqual(
      fixture('search_error_detail')
    )
  })

  test('canonical mutation encoding', () => {
    const value = z
      .object({ mutation: mutationSchema, canonical_json: z.string() })
      .parse(fixture('canonical_mutation'))
    expect(canonicalJson(value.mutation)).toBe(value.canonical_json)
  })
})

// The Rust twin (flat_schema::validate_title) runs this same fixture in
// schema/tests/fixtures.rs, keeping the two implementations in lockstep.
describe('title rule matches the Rust rule', () => {
  const titles = z
    .object({ valid: z.array(z.string()), invalid: z.array(z.string()) })
    .parse(fixture('titles'))

  test('valid titles pass', () => {
    for (const title of titles.valid) {
      expect(invalidTitle(title), JSON.stringify(title)).toBeNull()
    }
  })

  test('invalid titles are rejected', () => {
    for (const title of titles.invalid) {
      expect(invalidTitle(title), JSON.stringify(title)).not.toBeNull()
    }
  })
})

describe('email rule matches the Rust rule', () => {
  const emails = z
    .object({
      valid: z.array(z.object({ input: z.string(), normalized: z.string() })),
      invalid: z.array(z.string()),
    })
    .parse(fixture('emails'))

  test('valid emails normalize', () => {
    for (const email of emails.valid) {
      expect(invalidEmail(email.input)).toBe(email.normalized)
    }
  })

  test('invalid emails reject', () => {
    for (const email of emails.invalid) expect(invalidEmail(email)).toBeNull()
  })
})

describe('label name rule matches the Rust rule', () => {
  const labels = z
    .object({
      valid: z.array(z.object({ input: z.string(), normalized: z.string() })),
      invalid: z.array(z.string()),
    })
    .parse(fixture('labels'))

  test('valid names normalize', () => {
    for (const label of labels.valid) {
      expect(labelNameSchema.parse(label.input)).toBe(label.normalized)
    }
  })

  test('invalid names reject', () => {
    for (const name of labels.invalid) {
      expect(labelNameSchema.safeParse(name).success).toBe(false)
    }
  })
})

describe('comment body rule matches the Rust rule', () => {
  test('accepts Markdown and rejects empty or oversized UTF-8 bodies', () => {
    expect(invalidCommentBody('Markdown\n\n- works')).toBeNull()
    expect(invalidCommentBody(' \n\t')).not.toBeNull()
    expect(invalidCommentBody('\u0085')).not.toBeNull()
    expect(invalidCommentBody('\ufeff')).toBeNull()
    expect(invalidCommentBody('a'.repeat(MAX_COMMENT_BYTES))).toBeNull()
    expect(invalidCommentBody('a'.repeat(MAX_COMMENT_BYTES + 1))).not.toBeNull()
    expect(invalidCommentBody('é'.repeat(MAX_COMMENT_BYTES / 2))).toBeNull()
    expect(invalidCommentBody('é'.repeat(MAX_COMMENT_BYTES / 2 + 1))).not.toBeNull()
  })
})

describe('ticket body rule matches the Rust rule', () => {
  test('reserves only an exact comment sentinel line', () => {
    expect(invalidTicketBody('ordinary <!-- flat:comments --> text')).toBeNull()
    expect(invalidTicketBody('before\n<!-- flat:comments -->\nafter')).not.toBeNull()
    expect(invalidTicketBody('before\r\n<!-- flat:comments -->\r\nafter')).not.toBeNull()
  })
})

describe('project description rule', () => {
  test('bounds UTF-8 without requiring content', () => {
    expect(invalidProjectDescription('')).toBeNull()
    expect(invalidProjectDescription('a'.repeat(MAX_PROJECT_DESCRIPTION_BYTES))).toBeNull()
    expect(invalidProjectDescription('a'.repeat(MAX_PROJECT_DESCRIPTION_BYTES + 1))).not.toBeNull()
    expect(invalidProjectDescription('é'.repeat(MAX_PROJECT_DESCRIPTION_BYTES / 2))).toBeNull()
    expect(
      invalidProjectDescription('é'.repeat(MAX_PROJECT_DESCRIPTION_BYTES / 2 + 1))
    ).not.toBeNull()
  })
})
