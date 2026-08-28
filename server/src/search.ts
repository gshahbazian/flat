import { z } from 'zod'

import {
  Priority,
  SearchMatchSource,
  SearchSort,
  Status,
  type SearchRequest,
  type SearchResponse,
  type SearchResult,
} from './schema.gen'
import { invalidEmail } from './validate'

const MAX_QUERY_BYTES = 4 * 1024
const MAX_CLAUSES = 50
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100
const TICKET_KEY = /^([A-Za-z][A-Za-z0-9]{1,7})-([1-9][0-9]*)$/
const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9]{1,7}$/
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/

type SearchErrorCode = 'invalid_search_query' | 'search_query_too_large' | 'invalid_search_cursor'

type Comparison = '=' | '<' | '<=' | '>' | '>='

interface DateFilter {
  comparison: Comparison
  timestamp: string
}

interface Alternative {
  value: string
  offset: number
}

type AssigneeFilter = { kind: 'email'; email: string } | { kind: 'me' } | { kind: 'none' }

export interface ParsedSearchQuery {
  text: string[]
  key: string | null
  projects: string[] | null
  statuses: Status[] | null
  priorities: Priority[] | null
  assignees: AssigneeFilter[] | null
  created: DateFilter | null
  updated: DateFilter | null
}

interface SearchCursor {
  v: 1
  binding: string
  sort: SearchSort
  rank?: number
  time: string
  key: string
}

const searchCursorSchema = z
  .object({
    v: z.literal(1),
    binding: z.string(),
    sort: z.enum(SearchSort),
    rank: z.number().optional(),
    time: z.string().refine((value) => Number.isFinite(Date.parse(value))),
    key: z.string().regex(TICKET_KEY),
  })
  .strict()

interface SearchRow {
  ticket_id: string | null
  key: string
  title: string
  project: string
  status: Status
  priority: Priority
  assignee: string | null
  created_at: string
  updated_at: string
  source_kind: 'ticket' | 'comment' | null
  source_id: string | null
  excerpt: string | null
  search_rank: number | null
}

type SearchValue = ArrayBuffer | string | number | null

export interface SearchSql {
  exec<T extends Record<string, SearchValue>>(
    query: string,
    ...bindings: Array<string | number | null>
  ): { toArray(): T[] }
}

export class SearchQueryError extends Error {
  constructor(
    readonly code: SearchErrorCode,
    message: string,
    readonly offset: number
  ) {
    super(message)
  }
}

function byteOffset(query: string, characterOffset: number): number {
  return new TextEncoder().encode(query.slice(0, characterOffset)).byteLength
}

function fail(query: string, message: string, characterOffset: number): never {
  throw new SearchQueryError('invalid_search_query', message, byteOffset(query, characterOffset))
}

function parseQuoted(query: string, start: number) {
  let value = ''
  let index = start + 1
  while (index < query.length) {
    const character = query[index]
    if (character === '"') return { value, end: index + 1 }
    if (character !== '\\') {
      value += character
      index += 1
      continue
    }
    const escaped = query[index + 1]
    if (escaped !== '"' && escaped !== '\\') {
      fail(query, 'invalid escape in quoted value', index)
    }
    value += escaped
    index += 2
  }
  return fail(query, 'unclosed quote', start)
}

function nextWhitespace(query: string, start: number): number {
  let index = start
  while (index < query.length && !/\s/u.test(query[index])) index += 1
  return index
}

function splitAlternatives(
  query: string,
  value: string,
  offset: number,
  qualifier: string
): Alternative[] {
  const alternatives: Alternative[] = []
  let start = 0
  for (const item of value.split(',')) {
    if (item.length === 0) fail(query, `${qualifier} contains an empty value`, offset + start)
    alternatives.push({ value: item, offset: offset + start })
    start += item.length + 1
  }
  return alternatives
}

function validCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function parseDateFilter(query: string, value: string, offset: number): DateFilter {
  const comparisons: Comparison[] = ['>=', '<=', '=', '>', '<']
  const comparison = comparisons.find((candidate) => value.startsWith(candidate))
  if (!comparison) fail(query, 'date qualifier requires a comparison operator', offset)
  const timestamp = value.slice(comparison.length)
  const dateMatch = DATE.exec(timestamp)
  if (dateMatch) {
    const [, year, month, day] = dateMatch
    if (!validCalendarDate(Number(year), Number(month), Number(day))) {
      fail(query, `invalid date ${JSON.stringify(timestamp)}`, offset + comparison.length)
    }
    return { comparison, timestamp: `${timestamp}T00:00:00.000Z` }
  }

  const timestampMatch = RFC3339.exec(timestamp)
  if (!timestampMatch) {
    fail(query, `invalid date ${JSON.stringify(timestamp)}`, offset + comparison.length)
  }
  const [, year, month, day, hour, minute, second] = timestampMatch
  if (
    !validCalendarDate(Number(year), Number(month), Number(day)) ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59
  ) {
    fail(query, `invalid date ${JSON.stringify(timestamp)}`, offset + comparison.length)
  }
  const milliseconds = Date.parse(timestamp)
  if (!Number.isFinite(milliseconds)) {
    fail(query, `invalid date ${JSON.stringify(timestamp)}`, offset + comparison.length)
  }
  return { comparison, timestamp: new Date(milliseconds).toISOString() }
}

function sortedUnique<T extends string>(values: T[]): T[] {
  return [...new Set(values)].toSorted()
}

function parseStatus(value: string): Status | null {
  if (value === 'backlog') return Status.Backlog
  if (value === 'todo') return Status.Todo
  if (value === 'in_progress') return Status.InProgress
  if (value === 'in_review') return Status.InReview
  if (value === 'done') return Status.Done
  if (value === 'canceled') return Status.Canceled
  return null
}

function parsePriority(value: string): Priority | null {
  if (value === 'none') return Priority.None
  if (value === 'low') return Priority.Low
  if (value === 'medium') return Priority.Medium
  if (value === 'high') return Priority.High
  if (value === 'urgent') return Priority.Urgent
  return null
}

export function parseSearchQuery(query: string): ParsedSearchQuery {
  const queryBytes = new TextEncoder().encode(query).byteLength
  if (queryBytes > MAX_QUERY_BYTES) {
    throw new SearchQueryError(
      'search_query_too_large',
      `query exceeds the ${MAX_QUERY_BYTES}-byte limit`,
      MAX_QUERY_BYTES
    )
  }
  if (query.trim().length === 0) fail(query, 'query must not be empty', 0)

  const parsed: ParsedSearchQuery = {
    text: [],
    key: null,
    projects: null,
    statuses: null,
    priorities: null,
    assignees: null,
    created: null,
    updated: null,
  }
  const qualifiers = new Set<string>()
  let clauseCount = 0
  let index = 0
  while (index < query.length) {
    while (index < query.length && /\s/u.test(query[index])) index += 1
    if (index === query.length) break
    clauseCount += 1
    if (clauseCount > MAX_CLAUSES) {
      throw new SearchQueryError(
        'search_query_too_large',
        `query contains more than ${MAX_CLAUSES} clauses`,
        byteOffset(query, index)
      )
    }

    const clauseOffset = index
    if (query[index] === '"') {
      const phrase = parseQuoted(query, index)
      if (phrase.end < query.length && !/\s/u.test(query[phrase.end])) {
        fail(query, 'unexpected text after quoted phrase', phrase.end)
      }
      if (phrase.value.trim().length === 0) fail(query, 'text clause must not be empty', index)
      parsed.text.push(phrase.value.toLocaleLowerCase('en-US'))
      index = phrase.end
      continue
    }

    const end = nextWhitespace(query, index)
    const raw = query.slice(index, end)
    const colon = raw.indexOf(':')
    if (colon === -1) {
      const keyMatch = TICKET_KEY.exec(raw)
      if (keyMatch) {
        if (parsed.key !== null) fail(query, 'ticket key may appear only once', clauseOffset)
        parsed.key = `${keyMatch[1].toUpperCase()}-${keyMatch[2]}`
      } else {
        parsed.text.push(raw.toLocaleLowerCase('en-US'))
      }
      index = end
      continue
    }

    const qualifier = raw.slice(0, colon).toLocaleLowerCase('en-US')
    const known = ['project', 'status', 'priority', 'assignee', 'created', 'updated']
    if (!known.includes(qualifier)) {
      fail(query, `unknown qualifier ${JSON.stringify(qualifier)}`, clauseOffset)
    }
    if (qualifiers.has(qualifier)) {
      fail(query, `qualifier ${JSON.stringify(qualifier)} may appear only once`, clauseOffset)
    }
    qualifiers.add(qualifier)

    let value = raw.slice(colon + 1)
    let valueOffset = clauseOffset + colon + 1
    if (value.startsWith('"')) {
      const quoted = parseQuoted(query, valueOffset)
      if (quoted.end < query.length && !/\s/u.test(query[quoted.end])) {
        fail(query, 'unexpected text after quoted value', quoted.end)
      }
      value = quoted.value
      index = quoted.end
    } else {
      index = end
    }
    if (value.length === 0) fail(query, `${qualifier} requires a value`, valueOffset)

    if (qualifier === 'project') {
      const projects = splitAlternatives(query, value, valueOffset, qualifier)
      for (const project of projects) {
        if (!PROJECT_KEY.test(project.value)) {
          fail(query, `invalid project key ${JSON.stringify(project.value)}`, project.offset)
        }
      }
      parsed.projects = sortedUnique(projects.map((project) => project.value.toUpperCase()))
      continue
    }
    if (qualifier === 'status') {
      const statuses = splitAlternatives(query, value, valueOffset, qualifier)
      const parsedStatuses: Status[] = []
      for (const status of statuses) {
        const parsedStatus = parseStatus(status.value)
        if (parsedStatus === null) {
          fail(query, `unknown status ${JSON.stringify(status.value)}`, status.offset)
        }
        parsedStatuses.push(parsedStatus)
      }
      parsed.statuses = sortedUnique(parsedStatuses)
      continue
    }
    if (qualifier === 'priority') {
      const priorities = splitAlternatives(query, value, valueOffset, qualifier)
      const parsedPriorities: Priority[] = []
      for (const priority of priorities) {
        const parsedPriority = parsePriority(priority.value)
        if (parsedPriority === null) {
          fail(query, `unknown priority ${JSON.stringify(priority.value)}`, priority.offset)
        }
        parsedPriorities.push(parsedPriority)
      }
      parsed.priorities = sortedUnique(parsedPriorities)
      continue
    }
    if (qualifier === 'assignee') {
      const assignees = splitAlternatives(query, value, valueOffset, qualifier).map(
        (assignee): AssigneeFilter => {
          const normalized = assignee.value.toLocaleLowerCase('en-US')
          if (normalized === 'me') return { kind: 'me' }
          if (normalized === 'none') return { kind: 'none' }
          const email = invalidEmail(assignee.value)
          if (email === null) {
            fail(query, `invalid assignee ${JSON.stringify(assignee.value)}`, assignee.offset)
          }
          return { kind: 'email', email }
        }
      )
      parsed.assignees = assignees.toSorted((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right))
      )
      continue
    }
    if (value.includes(',')) fail(query, `${qualifier} accepts one comparison`, valueOffset)
    const date = parseDateFilter(query, value, valueOffset)
    if (qualifier === 'created') parsed.created = date
    if (qualifier === 'updated') parsed.updated = date
  }

  return parsed
}

function ftsString(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

export function compileFtsQuery(text: string[]): string {
  return text.map(ftsString).join(' AND ')
}

function queryBinding(query: ParsedSearchQuery, sort: SearchSort): string {
  return JSON.stringify({
    text: query.text,
    key: query.key,
    projects: query.projects,
    statuses: query.statuses,
    priorities: query.priorities,
    assignees: query.assignees,
    created: query.created,
    updated: query.updated,
    sort,
  })
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function decodeBase64Url(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid base64url')
  const padding = '='.repeat((4 - (value.length % 4)) % 4)
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + padding)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
}

function parseCursor(raw: string, binding: string, sort: SearchSort): SearchCursor {
  try {
    const parsed = searchCursorSchema.safeParse(JSON.parse(decodeBase64Url(raw)))
    if (!parsed.success) throw new Error()
    const cursor = parsed.data
    if (cursor.binding !== binding || cursor.sort !== sort) throw new Error()
    if (sort === SearchSort.Relevance && cursor.rank === undefined) throw new Error()
    if (sort !== SearchSort.Relevance && cursor.rank !== undefined) throw new Error()
    return cursor
  } catch {
    throw new SearchQueryError('invalid_search_cursor', 'cursor is invalid for this search', 0)
  }
}

function cursorFor(row: SearchRow, binding: string, sort: SearchSort): string {
  const cursor: SearchCursor = {
    v: 1,
    binding,
    sort,
    time: sort === SearchSort.Created ? row.created_at : row.updated_at,
    key: row.key,
  }
  if (sort === SearchSort.Relevance) {
    if (row.search_rank === null) throw new Error('relevance result has no rank')
    cursor.rank = row.search_rank
  }
  return encodeBase64Url(JSON.stringify(cursor))
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ')
}

function addFilters(
  conditions: string[],
  bindings: Array<string | number | null>,
  query: ParsedSearchQuery,
  memberId: string
): void {
  if (query.key !== null) {
    conditions.push('t.key = ? COLLATE NOCASE')
    bindings.push(query.key)
  }
  if (query.projects !== null) {
    conditions.push(`p.key IN (${placeholders(query.projects.length)})`)
    bindings.push(...query.projects)
  }
  if (query.statuses !== null) {
    conditions.push(`t.status IN (${placeholders(query.statuses.length)})`)
    bindings.push(...query.statuses)
  }
  if (query.priorities !== null) {
    conditions.push(`t.priority IN (${placeholders(query.priorities.length)})`)
    bindings.push(...query.priorities)
  }
  if (query.assignees !== null) {
    const alternatives: string[] = []
    for (const assignee of query.assignees) {
      if (assignee.kind === 'none') {
        alternatives.push('t.assignee IS NULL')
        continue
      }
      if (assignee.kind === 'me') {
        alternatives.push('t.assignee = ?')
        bindings.push(memberId)
        continue
      }
      alternatives.push('m.email = ?')
      bindings.push(assignee.email)
    }
    conditions.push(`(${alternatives.join(' OR ')})`)
  }
  for (const [column, filter] of [
    ['created_at', query.created],
    ['updated_at', query.updated],
  ] as const) {
    if (filter === null) continue
    conditions.push(`t.${column} ${filter.comparison} ?`)
    bindings.push(filter.timestamp)
  }
}

function addCursor(
  conditions: string[],
  bindings: Array<string | number | null>,
  cursor: SearchCursor,
  sort: SearchSort
): void {
  if (sort === SearchSort.Relevance) {
    conditions.push(
      '(best.search_rank > ? OR (best.search_rank = ? AND t.updated_at < ?) OR ' +
        '(best.search_rank = ? AND t.updated_at = ? AND t.key > ?))'
    )
    bindings.push(cursor.rank ?? null, cursor.rank ?? null, cursor.time)
    bindings.push(cursor.rank ?? null, cursor.time, cursor.key)
    return
  }
  const column = sort === SearchSort.Created ? 'created_at' : 'updated_at'
  conditions.push(`(t.${column} < ? OR (t.${column} = ? AND t.key > ?))`)
  bindings.push(cursor.time, cursor.time, cursor.key)
}

function orderBy(sort: SearchSort): string {
  if (sort === SearchSort.Relevance) {
    return 'best.search_rank ASC, t.updated_at DESC, t.key ASC'
  }
  if (sort === SearchSort.Created) return 't.created_at DESC, t.key ASC'
  return 't.updated_at DESC, t.key ASC'
}

function plainExcerpt(value: string | null): string | null {
  if (value === null) return null
  let result = ''
  let index = 0
  while (index < value.length) {
    const code = value.charCodeAt(index)
    if (code === 27) {
      index += 1
      if (value[index] === '[') index += 1
      while (index < value.length) {
        const final = value.charCodeAt(index)
        index += 1
        if (final >= 0x40 && final <= 0x7e) break
      }
      continue
    }
    if ((code < 32 && code !== 9 && code !== 10) || (code >= 0x7f && code <= 0x9f)) {
      index += 1
      continue
    }
    result += value[index]
    index += 1
  }
  return result
}

function resultFromRow(row: SearchRow, hasText: boolean, hasKey: boolean): SearchResult {
  let source = SearchMatchSource.Ticket
  if (hasText && row.source_kind === 'comment') source = SearchMatchSource.Comment
  if (!hasText && hasKey) source = SearchMatchSource.Key
  const match: SearchResult['match'] = {
    source,
    excerpt: hasText ? plainExcerpt(row.excerpt) : null,
  }
  if (source === SearchMatchSource.Comment && row.source_id !== null) {
    match.comment_id = row.source_id
  }
  return {
    key: row.key,
    title: row.title,
    project: row.project,
    status: row.status,
    priority: row.priority,
    assignee: row.assignee,
    created_at: row.created_at,
    updated_at: row.updated_at,
    match,
  }
}

function searchTextTickets(
  sql: SearchSql,
  parsed: ParsedSearchQuery,
  memberId: string,
  sort: SearchSort,
  limit: number,
  cursor: SearchCursor | null,
  binding: string
): SearchResponse {
  const bindings: Array<string | number | null> = [compileFtsQuery(parsed.text)]
  const conditions = ['best.match_number = 1']
  addFilters(conditions, bindings, parsed, memberId)
  if (cursor !== null) addCursor(conditions, bindings, cursor, sort)
  bindings.push(limit + 1)
  const page = sql
    .exec<SearchRow & Record<string, SearchValue>>(
      `WITH raw_matches AS MATERIALIZED (
         SELECT ticket_id, source_kind, source_id,
           ticket_search.rank AS search_rank,
           snippet(ticket_search, -1, '', '', '...', 32) AS excerpt
         FROM ticket_search
         WHERE ticket_search MATCH ?
           AND ticket_search.rank MATCH 'bm25(0, 0, 0, 10, 3, 1)'
       ), best_matches AS (
         SELECT *, row_number() OVER (
           PARTITION BY ticket_id
           ORDER BY search_rank, source_kind DESC, source_id
         ) AS match_number
         FROM raw_matches
       )
       SELECT t.id AS ticket_id, t.key, t.title, p.key AS project, t.status, t.priority,
         m.email AS assignee, t.created_at, t.updated_at,
         best.source_kind, best.source_id, best.excerpt, best.search_rank
       FROM best_matches best
       JOIN tickets t ON t.id = best.ticket_id
       JOIN projects p ON p.id = t.project
       LEFT JOIN members m ON m.id = t.assignee
       WHERE ${conditions.join(' AND ')}
       ORDER BY ${orderBy(sort)}
       LIMIT ?`,
      ...bindings
    )
    .toArray()
  const hasNext = page.length > limit
  if (hasNext) page.pop()
  return {
    results: page.map((row) => resultFromRow(row, true, parsed.key !== null)),
    next_cursor: hasNext ? cursorFor(page[page.length - 1], binding, sort) : null,
  }
}

export function searchTickets(
  sql: SearchSql,
  request: SearchRequest,
  memberId: string
): SearchResponse {
  const parsed = parseSearchQuery(request.query)
  const hasText = parsed.text.length > 0
  const sort = request.sort ?? (hasText ? SearchSort.Relevance : SearchSort.Updated)
  if (sort === SearchSort.Relevance && !hasText) {
    throw new SearchQueryError(
      'invalid_search_query',
      'relevance sorting requires a text clause',
      0
    )
  }
  const limit = request.limit ?? DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new SearchQueryError(
      'invalid_search_query',
      `limit must be between 1 and ${MAX_LIMIT}`,
      0
    )
  }
  const binding = queryBinding(parsed, sort)
  const cursor = request.cursor ? parseCursor(request.cursor, binding, sort) : null
  if (hasText) {
    return searchTextTickets(sql, parsed, memberId, sort, limit, cursor, binding)
  }
  const bindings: Array<string | number | null> = []
  const conditions: string[] = []
  const sourceColumns = `NULL AS source_kind, NULL AS source_id, NULL AS excerpt,
    NULL AS search_rank`
  const from = `tickets t
    JOIN projects p ON p.id = t.project
    LEFT JOIN members m ON m.id = t.assignee`
  addFilters(conditions, bindings, parsed, memberId)
  if (cursor !== null) addCursor(conditions, bindings, cursor, sort)
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const sqlQuery = `SELECT t.id AS ticket_id, t.key, t.title, p.key AS project, t.status,
      t.priority, m.email AS assignee, t.created_at, t.updated_at, ${sourceColumns}
    FROM ${from}
    ${where}
    ORDER BY ${orderBy(sort)}
    LIMIT ?`
  bindings.push(limit + 1)
  const rows = sql.exec<SearchRow & Record<string, SearchValue>>(sqlQuery, ...bindings).toArray()
  const hasNext = rows.length > limit
  if (hasNext) rows.pop()
  return {
    results: rows.map((row) => resultFromRow(row, hasText, parsed.key !== null)),
    next_cursor: hasNext ? cursorFor(rows[rows.length - 1], binding, sort) : null,
  }
}
