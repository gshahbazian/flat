import { DatabaseSync } from 'node:sqlite'

import { describe, expect, test } from 'vitest'

import type { JsonObject } from '../src/request-schema'
import { SearchSort } from '../src/schema.gen'
import {
  compileFtsQuery,
  parseSearchQuery,
  SearchQueryError,
  searchTickets,
  type SearchSql,
} from '../src/search'

class TestSql implements SearchSql {
  readonly queries: string[] = []

  constructor(readonly database = new DatabaseSync(':memory:')) {}

  exec<T extends Record<string, ArrayBuffer | string | number | null>>(
    query: string,
    ...bindings: Array<string | number | null>
  ) {
    this.queries.push(query)
    // SAFETY: The query's selected columns define T, and each test creates the matching schema.
    const rows = this.database.prepare(query).all(...bindings) as T[]
    return { toArray: () => rows }
  }
}

function searchDatabase(): TestSql {
  const sql = new TestSql()
  sql.database.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, key TEXT NOT NULL);
    CREATE TABLE members (id TEXT PRIMARY KEY, email TEXT NOT NULL);
    CREATE TABLE tickets (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL,
      project TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      assignee TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE ticket_search USING fts5(
      ticket_id UNINDEXED,
      source_kind UNINDEXED,
      source_id UNINDEXED,
      title,
      description,
      comment,
      tokenize = 'unicode61 remove_diacritics 2'
    );
    INSERT INTO projects VALUES ('project-auth', 'AUTH'), ('project-ops', 'OPS');
    INSERT INTO members VALUES ('member-me', 'me@example.com'), ('member-old', 'old@example.com');
    INSERT INTO tickets VALUES
      ('title', 'AUTH-1', 'project-auth', 'Needle title', 'ordinary body', 'todo', 'high',
       'member-me', '2026-08-01T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
      ('description', 'AUTH-2', 'project-auth', 'Ordinary title', 'Needle body',
       'in_progress', 'medium', 'member-old', '2026-08-02T00:00:00.000Z',
       '2026-08-03T00:00:00.000Z'),
      ('comment', 'OPS-1', 'project-ops', 'Another title', 'Another body', 'done', 'none',
       NULL, '2026-08-03T00:00:00.000Z', '2026-08-02T00:00:00.000Z'),
      ('other', 'OPS-2', 'project-ops', 'Unrelated', 'Nothing here', 'canceled', 'urgent',
       NULL, '2026-08-04T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
    INSERT INTO ticket_search VALUES
      ('title', 'ticket', 'title', 'Needle title', 'ordinary body', ''),
      ('title', 'comment', 'title-comment', '', '', 'A weaker needle comment'),
      ('description', 'ticket', 'description', 'Ordinary title', 'Needle body', ''),
      ('comment', 'ticket', 'comment', 'Another title', 'Another body', ''),
      ('comment', 'comment', 'comment-1', '', '', 'Needle in a comment'),
      ('other', 'ticket', 'other', 'Unrelated', 'Nothing here', '');
  `)
  return sql
}

function request(query: string, overrides: JsonObject = {}) {
  return {
    query,
    cursor: null,
    ...overrides,
  }
}

function queryFailure(query: string): SearchQueryError {
  try {
    parseSearchQuery(query)
  } catch (error) {
    if (error instanceof SearchQueryError) return error
    throw error
  }
  throw new Error('expected query failure')
}

describe('search query parser', () => {
  test('normalizes text, exact keys, alternatives, assignees, and dates', () => {
    expect(
      parseSearchQuery(
        'OAuth "Token \\"Race\\"" auth-142 project:auth status:todo,in_progress ' +
          'priority:high,none assignee:ME,Old@Example.com,none created:>=2026-08-01 ' +
          'updated:<2026-08-26T03:00:00-07:00'
      )
    ).toEqual({
      text: ['oauth', 'token "race"'],
      key: 'AUTH-142',
      projects: ['AUTH'],
      statuses: ['in_progress', 'todo'],
      priorities: ['high', 'none'],
      labels: null,
      assignees: [{ kind: 'email', email: 'old@example.com' }, { kind: 'me' }, { kind: 'none' }],
      created: { comparison: '>=', timestamp: '2026-08-01T00:00:00.000Z' },
      updated: { comparison: '<', timestamp: '2026-08-26T10:00:00.000Z' },
    })
  })

  test('quotes every clause instead of exposing FTS syntax', () => {
    expect(compileFtsQuery(['oauth', 'or', 'title:*'])).toBe('"oauth" AND "or" AND "title:*"')
  })

  test('normalizes label alternatives and the unlabeled sentinel', () => {
    expect(parseSearchQuery('label:Bug,none').labels).toEqual(['bug', 'none'])
    expect(() => parseSearchQuery('label:bad$name')).toThrow('invalid label')
  })

  test.each([
    ['', 'query must not be empty'],
    ['status:working', 'unknown status'],
    ['status:todo status:done', 'may appear only once'],
    ['unknown:value', 'unknown qualifier'],
    ['"unclosed', 'unclosed quote'],
    ['"bad\\n"', 'invalid escape'],
    ['project:', 'requires a value'],
    ['updated:2026-08-01', 'comparison operator'],
    ['updated:>=2026-02-30', 'invalid date'],
    ['AUTH-1 OPS-2', 'ticket key may appear only once'],
  ])('rejects %j at the first error', (query, message) => {
    expect(() => parseSearchQuery(query)).toThrow(message)
  })

  test('reports UTF-8 byte offsets', () => {
    expect(queryFailure('é bad:value').offset).toBe(3)
    expect(queryFailure('status:todo,working').offset).toBe(12)
  })

  test('enforces byte and clause bounds with the stable error code', () => {
    const queries = ['é'.repeat(2049), Array.from({ length: 51 }, () => 'x').join(' ')]
    expect(queries.map((query) => queryFailure(query).code)).toEqual([
      'search_query_too_large',
      'search_query_too_large',
    ])
  })
})

describe('ticket search retrieval', () => {
  test('deduplicates documents and ranks title before description before comment', () => {
    const sql = searchDatabase()
    const response = searchTickets(sql, request('needle'), 'member-me')
    expect(response.results.map((result) => result.key)).toEqual(['AUTH-1', 'AUTH-2', 'OPS-1'])
    expect(response.results[0].match.source).toBe('ticket')
    expect(response.results[2].match).toMatchObject({
      source: 'comment',
      comment_id: 'comment-1',
    })
    expect(sql.queries).toHaveLength(1)
    expect(sql.queries[0]).toContain('AS MATERIALIZED')
    expect(sql.queries[0]).toContain('LIMIT ?')
    expect(sql.queries[0]).not.toContain('json_each')
  })

  test('combines structured filters and resolves me, none, and member email', () => {
    const sql = searchDatabase()
    expect(
      searchTickets(
        sql,
        request('status:todo,in_progress priority:medium,high assignee:me,old@example.com'),
        'member-me'
      ).results.map((result) => result.key)
    ).toEqual(['AUTH-1', 'AUTH-2'])
    expect(
      searchTickets(
        sql,
        request('project:OPS assignee:none updated:<=2026-08-02'),
        'member-me'
      ).results.map((result) => result.key)
    ).toEqual(['OPS-1', 'OPS-2'])
  })

  test('resolves an exact key case-insensitively without an excerpt', () => {
    const response = searchTickets(searchDatabase(), request('auth-2'), 'member-me')
    expect(response.results).toHaveLength(1)
    expect(response.results[0]).toMatchObject({
      key: 'AUTH-2',
      match: { source: 'key', excerpt: null },
    })
  })

  test('supports deterministic pagination and binds cursors to normalized inputs', () => {
    const sql = searchDatabase()
    const first = searchTickets(sql, request('needle', { limit: 1 }), 'member-me')
    expect(first.results.map((result) => result.key)).toEqual(['AUTH-1'])
    expect(first.next_cursor).not.toBeNull()
    const second = searchTickets(
      sql,
      request('NEEDLE', { limit: 1, cursor: first.next_cursor }),
      'member-me'
    )
    expect(second.results.map((result) => result.key)).toEqual(['AUTH-2'])
    expect(() =>
      searchTickets(sql, request('different', { cursor: first.next_cursor }), 'member-me')
    ).toThrow('cursor is invalid')
  })

  test('sorts filters-only searches by updated time and rejects relevance', () => {
    const sql = searchDatabase()
    expect(
      searchTickets(sql, request('status:todo,in_progress'), 'member-me').results.map(
        (result) => result.key
      )
    ).toEqual(['AUTH-1', 'AUTH-2'])
    expect(() =>
      searchTickets(sql, request('status:todo', { sort: SearchSort.Relevance }), 'member-me')
    ).toThrow('relevance sorting requires a text clause')
  })
})
