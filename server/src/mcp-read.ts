import { z } from 'zod'

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
import type { JsonObject } from './request-schema'
import type { Priority, Role, Status, TokenKind } from './schema.gen'
import { SearchQueryError, searchTickets } from './search'
import { sequenceSchema } from './wire-schema'

const commentCursorSchema = z
  .object({
    kind: z.literal('comments'),
    ticket_id: z.string(),
    watermark: sequenceSchema,
    last_seq: sequenceSchema,
    last_id: z.string().min(1),
  })
  .strict()

const projectCursorSchema = z
  .object({
    kind: z.literal('projects'),
    last_key: z.string(),
  })
  .strict()

const memberCursorSchema = z
  .object({
    kind: z.literal('members'),
    query: z.string(),
    last_email: z.string(),
  })
  .strict()

export function mcpSearchTickets(
  sql: SqlStorage,
  rawBody: JsonObject,
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

export function mcpGetTicket(sql: SqlStorage, rawBody: JsonObject, latestSeq: number): Response {
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
    const cursor = commentCursorSchema.safeParse(decodeMcpCursor(input.comment_cursor))
    if (!cursor.success || cursor.data.ticket_id !== ticket.id) {
      return mcpError(422, 'validation', 'invalid_cursor', 'Comment cursor is invalid.')
    }
    if (cursor.data.last_seq > cursor.data.watermark) {
      return mcpError(422, 'validation', 'invalid_cursor', 'Comment cursor is invalid.')
    }
    watermark = cursor.data.watermark
    lastSeq = cursor.data.last_seq
    lastId = cursor.data.last_id
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
    labels: sql
      .exec<{ id: string; name: string }>(
        `SELECT l.id, l.name FROM ticket_labels tl JOIN labels l ON l.id = tl.label_id
         WHERE tl.ticket_id = ? ORDER BY l.name`,
        ticket.id
      )
      .toArray(),
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

export function mcpListProjects(sql: SqlStorage, rawBody: JsonObject): Response {
  const parsed = listProjectsInputSchema.safeParse(rawBody)
  if (!parsed.success) {
    return mcpError(422, 'validation', 'invalid_arguments', 'Invalid project list request.')
  }
  let lastKey = ''
  if (parsed.data.cursor !== null) {
    const cursor = projectCursorSchema.safeParse(decodeMcpCursor(parsed.data.cursor))
    if (!cursor.success) {
      return mcpError(422, 'validation', 'invalid_cursor', 'Project cursor is invalid.')
    }
    lastKey = cursor.data.last_key
  }
  const rows = sql.exec<{ id: string; key: string; display_name: string; description: string }>(
    `SELECT id, key, display_name, description FROM projects
     WHERE key > ? ORDER BY key LIMIT ?`,
    lastKey,
    parsed.data.limit + 1
  )
  const projects: ListProjectsOutput['projects'] = []
  let hasMore = false
  for (const row of rows) {
    if (projects.length === parsed.data.limit) {
      hasMore = true
      break
    }
    const candidate: ListProjectsOutput = {
      projects: [...projects, row],
      next_cursor: encodeMcpCursor({ kind: 'projects', last_key: row.key }),
    }
    if (!mcpResultFits(candidate)) {
      if (projects.length === 0) {
        return mcpError(
          422,
          'validation',
          'result_too_large',
          'One complete project is too large to return.'
        )
      }
      hasMore = true
      break
    }
    projects.push(row)
  }
  const finalProject = projects[projects.length - 1]
  const output: ListProjectsOutput = {
    projects,
    next_cursor:
      hasMore && finalProject !== undefined
        ? encodeMcpCursor({ kind: 'projects', last_key: finalProject.key })
        : null,
  }
  return Response.json(output)
}

export function mcpListAssignableMembers(sql: SqlStorage, rawBody: JsonObject): Response {
  const parsed = listAssignableMembersInputSchema.safeParse(rawBody)
  if (!parsed.success) {
    return mcpError(422, 'validation', 'invalid_arguments', 'Invalid member list request.')
  }
  const { query } = parsed.data
  let lastEmail = ''
  if (parsed.data.cursor !== null) {
    const cursor = memberCursorSchema.safeParse(decodeMcpCursor(parsed.data.cursor))
    if (!cursor.success || cursor.data.query !== query) {
      return mcpError(422, 'validation', 'invalid_cursor', 'Member cursor is invalid.')
    }
    lastEmail = cursor.data.last_email
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
