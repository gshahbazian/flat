import { z } from 'zod'

import { Priority, Role, Status } from './schema.gen'
import {
  emailSchema,
  invalidCommentBody,
  invalidTicketBody,
  projectKeySchema,
  titleSchema,
} from './validate'
import { searchRequestSchema, searchResponseSchema, sequenceSchema } from './wire-schema'

export const MCP_PATH = '/mcp'
export const MCP_AUTH_PATH = '/_private/mcp/auth'
export const MCP_MAX_REQUEST_BYTES = 2 * 1024 * 1024
export const MCP_MAX_REQUEST_ID_BYTES = 256
export const MCP_MAX_RESULT_BYTES = 4 * 1024 * 1024
export const MCP_MAX_ERROR_BYTES = 16 * 1024
export const MCP_CORRELATION_HEADER = 'X-Flat-Correlation-Id'

const MCP_RESULT_FRAMING_BYTES = 1024

export const MCP_TOOLS = [
  'search_tickets',
  'get_ticket',
  'list_projects',
  'list_assignable_members',
  'create_ticket',
  'update_ticket',
  'add_comment',
] as const

export type McpToolName = (typeof MCP_TOOLS)[number]

export function mcpToolPath(tool: McpToolName): string {
  return `/_private/mcp/tools/${tool}`
}

const nullableCursorSchema = z.string().nullable().optional().default(null)
const pageLimitSchema = z.number().int().min(1).max(100).optional().default(50)
const normalizedProjectKeySchema = z
  .string()
  .transform((key) => key.toUpperCase())
  .pipe(projectKeySchema)
const normalizedTicketKeySchema = z
  .string()
  .transform((key) => key.toUpperCase())
  .refine((key) => /^[A-Z][A-Z0-9]{1,7}-[1-9][0-9]*$/.test(key), 'invalid ticket key')

const ticketBodySchema = z.string().superRefine((body, context) => {
  const reason = invalidTicketBody(body)
  if (reason) context.addIssue({ code: 'custom', message: reason })
})

const commentBodySchema = z.string().superRefine((body, context) => {
  const reason = invalidCommentBody(body)
  if (reason) context.addIssue({ code: 'custom', message: reason })
})

export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)

export const searchTicketsInputSchema = searchRequestSchema

export const getTicketInputSchema = z
  .object({
    key: normalizedTicketKeySchema,
    comment_limit: pageLimitSchema,
    comment_cursor: nullableCursorSchema,
  })
  .strict()

export const listProjectsInputSchema = z
  .object({
    limit: pageLimitSchema,
    cursor: nullableCursorSchema,
  })
  .strict()

export const listAssignableMembersInputSchema = z
  .object({
    query: z
      .string()
      .refine((query) => new TextEncoder().encode(query).byteLength <= 256)
      .transform((query) => query.toLowerCase())
      .optional()
      .default(''),
    limit: pageLimitSchema,
    cursor: nullableCursorSchema,
  })
  .strict()

export const createTicketInputSchema = z
  .object({
    idempotency_key: idempotencyKeySchema,
    project: normalizedProjectKeySchema,
    title: titleSchema,
    body: ticketBodySchema.optional().default(''),
    status: z.enum(Status).optional().default(Status.Todo),
    priority: z.enum(Priority).optional().default(Priority.None),
    assignee: emailSchema.nullable().optional().default(null),
  })
  .strict()

export const updateTicketSetSchema = z
  .object({
    title: titleSchema.optional(),
    body: ticketBodySchema.optional(),
    status: z.enum(Status).optional(),
    priority: z.enum(Priority).optional(),
    assignee: emailSchema.nullable().optional(),
  })
  .strict()
  .refine((set) => Object.keys(set).length > 0, 'set must contain at least one editable field')

export const updateTicketInputSchema = z
  .object({
    idempotency_key: idempotencyKeySchema,
    key: normalizedTicketKeySchema,
    base_seq: sequenceSchema,
    set: updateTicketSetSchema,
  })
  .strict()

export const addCommentInputSchema = z
  .object({
    idempotency_key: idempotencyKeySchema,
    key: normalizedTicketKeySchema,
    body: commentBodySchema,
  })
  .strict()

const safeMemberSchema = z
  .object({
    id: z.string(),
    email: z.string(),
  })
  .strict()

const nullableSafeMemberSchema = safeMemberSchema.nullable()

const ticketOutputSchema = z
  .object({
    id: z.string(),
    key: z.string(),
    project: z.object({ id: z.string(), key: z.string() }).strict(),
    title: z.string(),
    body: z.string(),
    status: z.enum(Status),
    priority: z.enum(Priority),
    assignee: nullableSafeMemberSchema,
    created_at: z.string(),
    updated_at: z.string(),
    seq: sequenceSchema,
  })
  .strict()

const commentOutputSchema = z
  .object({
    id: z.string(),
    body: z.string(),
    author: z
      .object({
        kind: z.enum(['human', 'agent']),
        member: safeMemberSchema,
        agent_name: z.string().nullable(),
        delegated_by: nullableSafeMemberSchema,
      })
      .strict(),
    created_at: z.string(),
    seq: sequenceSchema,
  })
  .strict()

export const getTicketOutputSchema = z
  .object({
    ticket: ticketOutputSchema,
    comments: z.array(commentOutputSchema),
    comment_watermark: sequenceSchema,
    next_comment_cursor: z.string().nullable(),
  })
  .strict()

export const listProjectsOutputSchema = z
  .object({
    projects: z.array(
      z
        .object({
          id: z.string(),
          key: z.string(),
          display_name: z.string(),
          description: z.string(),
        })
        .strict()
    ),
    next_cursor: z.string().nullable(),
  })
  .strict()

export const listAssignableMembersOutputSchema = z
  .object({
    members: z.array(z.object({ id: z.string(), email: z.string(), role: z.enum(Role) }).strict()),
    next_cursor: z.string().nullable(),
  })
  .strict()

export const writeReceiptSchema = z
  .object({
    key: z.string(),
    entity_id: z.string(),
    seq: sequenceSchema,
    replayed: z.boolean(),
  })
  .strict()

export const searchTicketsOutputSchema = searchResponseSchema

export type SearchTicketsInput = z.infer<typeof searchTicketsInputSchema>
export type GetTicketInput = z.infer<typeof getTicketInputSchema>
export type ListProjectsInput = z.infer<typeof listProjectsInputSchema>
export type ListAssignableMembersInput = z.infer<typeof listAssignableMembersInputSchema>
export type CreateTicketInput = z.infer<typeof createTicketInputSchema>
export type UpdateTicketInput = z.infer<typeof updateTicketInputSchema>
export type AddCommentInput = z.infer<typeof addCommentInputSchema>
export type GetTicketOutput = z.infer<typeof getTicketOutputSchema>
export type ListProjectsOutput = z.infer<typeof listProjectsOutputSchema>
export type ListAssignableMembersOutput = z.infer<typeof listAssignableMembersOutputSchema>
export type WriteReceipt = z.infer<typeof writeReceiptSchema>

export type McpErrorCategory =
  | 'authentication'
  | 'authorization'
  | 'validation'
  | 'not_found'
  | 'conflict'
  | 'internal'

export interface McpErrorDetail {
  category: McpErrorCategory
  code: string
  message: string
  retryable: boolean
  details?: Record<string, unknown>
}

export interface McpErrorBody {
  error: McpErrorDetail
}

export const mcpErrorBodySchema = z
  .object({
    error: z
      .object({
        category: z.enum([
          'authentication',
          'authorization',
          'validation',
          'not_found',
          'conflict',
          'internal',
        ]),
        code: z.string(),
        message: z.string(),
        retryable: z.boolean(),
        details: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
  })
  .strict()

export function mcpResultFits(value: unknown): boolean {
  const text = JSON.stringify(value)
  const result = {
    content: [{ type: 'text', text }],
    structuredContent: value,
  }
  const bytes = new TextEncoder().encode(JSON.stringify(result)).byteLength
  return bytes + MCP_RESULT_FRAMING_BYTES <= MCP_MAX_RESULT_BYTES
}

export function mcpErrorResultFits(value: McpErrorBody): boolean {
  const result = {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  }
  const bytes = new TextEncoder().encode(JSON.stringify(result)).byteLength
  return bytes + MCP_RESULT_FRAMING_BYTES <= MCP_MAX_ERROR_BYTES
}

export function encodeMcpCursor(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function decodeMcpCursor(value: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes))
  } catch {
    return null
  }
}
