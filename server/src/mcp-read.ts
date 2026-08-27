import { mcpError } from './mcp-response'
import {
  decodeMcpCursor,
  encodeMcpCursor,
  getTicketInputSchema,
  listAssignableMembersInputSchema,
  listProjectsInputSchema,
  mcpResultFits,
  searchTicketsInputSchema,
  type GetTicketOutput,
  type ListAssignableMembersOutput,
  type ListProjectsOutput,
} from './mcp-schema'
import type { Principal } from './policy'
import { jsonObjectSchema } from './request-schema'
import type { Priority, Role, Status, TokenKind } from './schema.gen'
import { SearchQueryError, searchTickets } from './search'

export function mcpSearchTickets(
  sql: SqlStorage,
  rawBody: Record<string, unknown>,
  principal: Principal
): Response {
  const parsed = searchTicketsInputSchema.safeParse(rawBody)
  if (!parsed.success) {
    return mcpError(422, 'validation', 'invalid_search_query', 'Invalid search request.')
  }
  try {
    return Response.json(searchTickets(sql, parsed.data, principal.memberId))
  } catch (error) {
    if (error instanceof SearchQueryError) {
      return mcpError(422, 'validation', error.code, error.message, false, {
        offset: error.offset,
      })
    }
    throw error
  }
}

export function mcpGetTicket(
  sql: SqlStorage,
  rawBody: Record<string, unknown>,
  latestSeq: number
): Response {
  const parsed = getTicketInputSchema.safeParse(rawBody)
  if (!parsed.success) {
    return mcpError(422, 'validation', 'invalid_arguments', 'Invalid ticket read request.')
  }
  const input = parsed.data
  const ticket = sql
    .exec<{
      id: string
      key: string
      project_id: string
      project_key: string
      title: string
      body: string
      status: Status
      priority: Priority
      assignee_id: string | null
      assignee_email: string | null
      created_at: string
      updated_at: string
      seq: number
    }>(
      `SELECT t.id, t.key, p.id AS project_id, p.key AS project_key, t.title, t.body,
              t.status, t.priority, m.id AS assignee_id, m.email AS assignee_email,
              t.created_at, t.updated_at, t.seq
       FROM tickets t JOIN projects p ON p.id = t.project
       LEFT JOIN members m ON m.id = t.assignee WHERE t.key = ?`,
      input.key
    )
    .toArray()[0]
  if (!ticket) {
    return mcpError(404, 'not_found', 'ticket_not_found', 'Ticket was not found.')
  }

  let watermark = latestSeq
  let lastSeq = -1
  let lastId = ''
  if (input.comment_cursor !== null) {
    const cursor = mcpCursor(input.comment_cursor)
    if (
      cursor === null ||
      cursor.kind !== 'comments' ||
      cursor.ticket_id !== ticket.id ||
      typeof cursor.watermark !== 'number' ||
      !Number.isInteger(cursor.watermark) ||
      cursor.watermark < 0 ||
      typeof cursor.last_seq !== 'number' ||
      !Number.isInteger(cursor.last_seq) ||
      cursor.last_seq < 0 ||
      typeof cursor.last_id !== 'string'
    ) {
      return mcpError(422, 'validation', 'invalid_cursor', 'Comment cursor is invalid.')
    }
    watermark = cursor.watermark
    lastSeq = cursor.last_seq
    lastId = cursor.last_id
  }

  const rows = sql.exec<{
    id: string
    body: string
    token_kind: TokenKind
    agent_name: string | null
    member_id: string
    member_email: string
    delegated_id: string | null
    delegated_email: string | null
    created_at: string
    seq: number
  }>(
    `SELECT c.id, c.body, c.token_kind, c.agent_name, m.id AS member_id,
            m.email AS member_email, d.id AS delegated_id, d.email AS delegated_email,
            c.created_at, c.seq
     FROM comments c JOIN members m ON m.id = c.member_id
     LEFT JOIN members d ON d.id = c.delegating_member_id
     WHERE c.ticket_id = ? AND c.seq <= ? AND (c.seq > ? OR (c.seq = ? AND c.id > ?))
     ORDER BY c.seq, c.id LIMIT ?`,
    ticket.id,
    watermark,
    lastSeq,
    lastSeq,
    lastId,
    input.comment_limit + 1
  )

  const ticketOutput: GetTicketOutput['ticket'] = {
    id: ticket.id,
    key: ticket.key,
    project: { id: ticket.project_id, key: ticket.project_key },
    title: ticket.title,
    body: ticket.body,
    status: ticket.status,
    priority: ticket.priority,
    assignee:
      ticket.assignee_id === null || ticket.assignee_email === null
        ? null
        : { id: ticket.assignee_id, email: ticket.assignee_email },
    created_at: ticket.created_at,
    updated_at: ticket.updated_at,
    seq: ticket.seq,
  }
  const comments: GetTicketOutput['comments'] = []
  let hasMore = false
  for (const row of rows) {
    if (comments.length === input.comment_limit) {
      hasMore = true
      break
    }
    const comment: GetTicketOutput['comments'][number] = {
      id: row.id,
      body: row.body,
      author: {
        kind: row.token_kind,
        member: { id: row.member_id, email: row.member_email },
        agent_name: row.agent_name,
        delegated_by:
          row.delegated_id === null || row.delegated_email === null
            ? null
            : { id: row.delegated_id, email: row.delegated_email },
      },
      created_at: row.created_at,
      seq: row.seq,
    }
    const nextCursor = encodeMcpCursor({
      kind: 'comments',
      ticket_id: ticket.id,
      watermark,
      last_seq: row.seq,
      last_id: row.id,
    })
    const candidate: GetTicketOutput = {
      ticket: ticketOutput,
      comments: [...comments, comment],
      comment_watermark: watermark,
      next_comment_cursor: nextCursor,
    }
    if (!mcpResultFits(candidate)) {
      if (comments.length === 0) {
        return mcpError(
          422,
          'validation',
          'result_too_large',
          'The ticket or one complete comment is too large to return.'
        )
      }
      hasMore = true
      break
    }
    comments.push(comment)
  }

  const finalComment = comments[comments.length - 1]
  const nextCommentCursor =
    hasMore && finalComment !== undefined
      ? encodeMcpCursor({
          kind: 'comments',
          ticket_id: ticket.id,
          watermark,
          last_seq: finalComment.seq,
          last_id: finalComment.id,
        })
      : null
  const output: GetTicketOutput = {
    ticket: ticketOutput,
    comments,
    comment_watermark: watermark,
    next_comment_cursor: nextCommentCursor,
  }
  if (!mcpResultFits(output)) {
    return mcpError(422, 'validation', 'result_too_large', 'The ticket is too large to return.')
  }
  return Response.json(output)
}

export function mcpListProjects(sql: SqlStorage, rawBody: Record<string, unknown>): Response {
  const parsed = listProjectsInputSchema.safeParse(rawBody)
  if (!parsed.success) {
    return mcpError(422, 'validation', 'invalid_arguments', 'Invalid project list request.')
  }
  let lastKey = ''
  if (parsed.data.cursor !== null) {
    const cursor = mcpCursor(parsed.data.cursor)
    if (cursor === null || cursor.kind !== 'projects' || typeof cursor.last_key !== 'string') {
      return mcpError(422, 'validation', 'invalid_cursor', 'Project cursor is invalid.')
    }
    lastKey = cursor.last_key
  }
  const rows = sql
    .exec<{ id: string; key: string; display_name: string; description: string }>(
      `SELECT id, key, display_name, description FROM projects
       WHERE key > ? ORDER BY key LIMIT ?`,
      lastKey,
      parsed.data.limit + 1
    )
    .toArray()
  const hasMore = rows.length > parsed.data.limit
  if (hasMore) rows.pop()
  const output: ListProjectsOutput = {
    projects: rows,
    next_cursor: hasMore
      ? encodeMcpCursor({ kind: 'projects', last_key: rows[rows.length - 1].key })
      : null,
  }
  return Response.json(output)
}

export function mcpListAssignableMembers(
  sql: SqlStorage,
  rawBody: Record<string, unknown>
): Response {
  const parsed = listAssignableMembersInputSchema.safeParse(rawBody)
  if (!parsed.success) {
    return mcpError(422, 'validation', 'invalid_arguments', 'Invalid member list request.')
  }
  const { query } = parsed.data
  let lastEmail = ''
  if (parsed.data.cursor !== null) {
    const cursor = mcpCursor(parsed.data.cursor)
    if (
      cursor === null ||
      cursor.kind !== 'members' ||
      cursor.query !== query ||
      typeof cursor.last_email !== 'string'
    ) {
      return mcpError(422, 'validation', 'invalid_cursor', 'Member cursor is invalid.')
    }
    lastEmail = cursor.last_email
  }
  const rows = sql
    .exec<{ id: string; email: string; role: Role }>(
      `SELECT id, email, role FROM members
       WHERE status = 'active' AND email > ? AND instr(lower(email), ?) > 0
       ORDER BY email LIMIT ?`,
      lastEmail,
      query,
      parsed.data.limit + 1
    )
    .toArray()
  const hasMore = rows.length > parsed.data.limit
  if (hasMore) rows.pop()
  const output: ListAssignableMembersOutput = {
    members: rows,
    next_cursor: hasMore
      ? encodeMcpCursor({ kind: 'members', query, last_email: rows[rows.length - 1].email })
      : null,
  }
  return Response.json(output)
}

function mcpCursor(value: string): Record<string, unknown> | null {
  const decoded = decodeMcpCursor(value)
  const parsed = jsonObjectSchema.safeParse(decoded)
  return parsed.success ? parsed.data : null
}
