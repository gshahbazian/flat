import { z } from 'zod'

import {
  Entity,
  MemberStatus,
  MutationOp,
  Priority,
  Role,
  SearchMatchSource,
  SearchSort,
  Status,
  TokenKind,
  type AppliedMutation,
  type Comment,
  type MemberProfile,
  type Mutation,
  type MutationConflict,
  type Project,
  type ProjectTombstone,
  type SearchErrorDetail,
  type SearchRequest,
  type SearchResponse,
  type Snapshot,
  type SyncRequest,
  type SyncResponse,
  type Ticket,
  type TicketTombstone,
} from './schema.gen'
import { projectDescriptionSchema, projectKeySchema, projectNameSchema } from './validate'

export const MAX_SEQUENCE = 0xffff_ffff

export const sequenceSchema = z.number().int().min(0).max(MAX_SEQUENCE)
export const roleSchema = z.enum(Role)
export const memberStatusSchema = z.enum(MemberStatus)
export const mutationOpSchema = z.enum(MutationOp)
export const statusSchema = z.enum(Status)
export const prioritySchema = z.enum(Priority)
export const searchSortSchema = z.enum(SearchSort)
export const searchMatchSourceSchema = z.enum(SearchMatchSource)

const optionalStringSchema = z.preprocess(
  (value) => (value === null ? undefined : value),
  z.string().optional()
)
const optionalStatusSchema = z.preprocess(
  (value) => (value === null ? undefined : value),
  statusSchema.optional()
)
const optionalPrioritySchema = z.preprocess(
  (value) => (value === null ? undefined : value),
  prioritySchema.optional()
)

const ticketCreateSetSchema = z
  .object({
    project: z.string().optional(),
    title: z.string().optional(),
    status: statusSchema.optional(),
    priority: prioritySchema.optional(),
    assignee: z.string().nullable().optional(),
    body: z.string().optional(),
  })
  .strict()

const ticketCreateSetInputSchema = z
  .object({
    project: optionalStringSchema,
    title: optionalStringSchema,
    status: optionalStatusSchema,
    priority: optionalPrioritySchema,
    assignee: z.string().nullable().optional(),
    body: optionalStringSchema,
  })
  .strict()

export const ticketSetSchema = ticketCreateSetSchema.omit({ project: true })
export const ticketSetInputSchema = ticketCreateSetInputSchema.omit({ project: true })

const commentCreateSetSchema = z
  .object({
    ticket: z.string().optional(),
    body: z.string().optional(),
  })
  .strict()

const commentCreateSetInputSchema = z
  .object({
    ticket: optionalStringSchema,
    body: optionalStringSchema,
  })
  .strict()

const projectCreateSetSchema = z
  .object({
    key: projectKeySchema.optional(),
    display_name: projectNameSchema.optional(),
    description: projectDescriptionSchema.optional(),
  })
  .strict()

const projectUpdateSetSchema = projectCreateSetSchema.omit({ key: true })

const ownerDeltas = {
  owners_add: z.array(z.string()).optional().default([]),
  owners_remove: z.array(z.string()).optional().default([]),
}

const mutationBaseShape = {
  mutation_id: z.string().min(1),
  entity_id: z.string().min(1),
}

const ticketCreateMutationSchema = z.object({
  ...mutationBaseShape,
  entity: z.literal(Entity.Ticket),
  op: z.literal(MutationOp.Create),
  base_seq: z.undefined().optional(),
  set: ticketCreateSetSchema,
  owners_add: z.undefined().optional(),
  owners_remove: z.undefined().optional(),
})

const ticketUpdateMutationSchema = z.object({
  ...mutationBaseShape,
  entity: z.literal(Entity.Ticket),
  op: z.literal(MutationOp.Update),
  base_seq: sequenceSchema,
  set: ticketSetSchema,
  owners_add: z.undefined().optional(),
  owners_remove: z.undefined().optional(),
})

const ticketDeleteMutationSchema = z.object({
  ...mutationBaseShape,
  entity: z.literal(Entity.Ticket),
  op: z.literal(MutationOp.Delete),
  base_seq: sequenceSchema,
  set: z.object({}).strict(),
  owners_add: z.undefined().optional(),
  owners_remove: z.undefined().optional(),
})

const commentCreateMutationSchema = z.object({
  ...mutationBaseShape,
  entity: z.literal(Entity.Comment),
  op: z.literal(MutationOp.Create),
  base_seq: z.undefined().optional(),
  set: commentCreateSetSchema,
  owners_add: z.undefined().optional(),
  owners_remove: z.undefined().optional(),
})

const projectCreateMutationSchema = z.object({
  ...mutationBaseShape,
  entity: z.literal(Entity.Project),
  op: z.literal(MutationOp.Create),
  base_seq: z.undefined().optional(),
  set: projectCreateSetSchema,
  owners_add: z.undefined().optional(),
  owners_remove: z.undefined().optional(),
})

const projectUpdateMutationSchema = z.object({
  ...mutationBaseShape,
  ...ownerDeltas,
  entity: z.literal(Entity.Project),
  op: z.literal(MutationOp.Update),
  base_seq: sequenceSchema,
  set: projectUpdateSetSchema,
})

const projectDeleteMutationSchema = z.object({
  ...mutationBaseShape,
  entity: z.literal(Entity.Project),
  op: z.literal(MutationOp.Delete),
  base_seq: sequenceSchema,
  set: z.object({}).strict(),
  owners_add: z.undefined().optional(),
  owners_remove: z.undefined().optional(),
})

export const mutationSchema = z.union([
  ticketCreateMutationSchema,
  ticketUpdateMutationSchema,
  ticketDeleteMutationSchema,
  commentCreateMutationSchema,
  projectCreateMutationSchema,
  projectUpdateMutationSchema,
  projectDeleteMutationSchema,
]) satisfies z.ZodType<Mutation>

const mutationInputSchemas = [
  ticketCreateMutationSchema.extend({ set: ticketCreateSetInputSchema.optional().default({}) }),
  ticketUpdateMutationSchema.extend({ set: ticketSetInputSchema.optional().default({}) }),
  ticketDeleteMutationSchema.extend({ set: z.object({}).strict().optional().default({}) }),
  commentCreateMutationSchema.extend({
    set: commentCreateSetInputSchema.optional().default({}),
  }),
  projectCreateMutationSchema.extend({ set: projectCreateSetSchema.optional().default({}) }),
  projectUpdateMutationSchema.extend({ set: projectUpdateSetSchema.optional().default({}) }),
  projectDeleteMutationSchema.extend({ set: z.object({}).strict().optional().default({}) }),
] as const

export const mutationInputSchema = z.union(mutationInputSchemas) satisfies z.ZodType<Mutation>

export const mutationRecordSchema = z.looseObject({})

export const mutationIdentitySchema = z.object({
  mutation_id: z.string().catch(''),
  entity_id: z.string().catch(''),
})

export const mutationAuthorizationSchema = z.object({
  mutation_id: z.string().min(1),
  entity_id: z.string().catch(''),
  entity: z.enum(Entity),
  op: mutationOpSchema,
  owners_add: z.unknown().optional(),
  owners_remove: z.unknown().optional(),
})

export const syncEnvelopeSchema = z.object({
  protocol_version: z.literal(2),
  last_seq: sequenceSchema,
  mutations: z.array(z.unknown()),
})

export const searchRequestSchema = z
  .object({
    query: z.string(),
    sort: searchSortSchema.optional(),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().nullable().optional().default(null),
  })
  .strict() satisfies z.ZodType<SearchRequest>

const searchMatchSchema = z
  .object({
    source: searchMatchSourceSchema,
    comment_id: z.string().optional(),
    excerpt: z.string().nullable(),
  })
  .strict()

const searchResultSchema = z
  .object({
    key: z.string(),
    title: z.string(),
    project: z.string(),
    status: statusSchema,
    priority: prioritySchema,
    assignee: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    match: searchMatchSchema,
  })
  .strict()

export const searchResponseSchema = z
  .object({
    results: z.array(searchResultSchema),
    next_cursor: z.string().nullable(),
  })
  .strict() satisfies z.ZodType<SearchResponse>

export const searchErrorDetailSchema = z
  .object({
    error: z.string(),
    message: z.string(),
    offset: z.number().int().nonnegative(),
  })
  .strict() satisfies z.ZodType<SearchErrorDetail>

export const syncRequestSchema = z.object({
  protocol_version: z.literal(2),
  last_seq: sequenceSchema,
  mutations: z.array(mutationSchema),
}) satisfies z.ZodType<SyncRequest>

export const appliedMutationSchema = z.object({
  mutation_id: z.string(),
  entity_id: z.string(),
  key: z.string(),
  seq: sequenceSchema,
}) satisfies z.ZodType<AppliedMutation>

export const mutationConflictSchema = z.object({
  mutation_id: z.string(),
  entity_id: z.string(),
  reason: z.string(),
}) satisfies z.ZodType<MutationConflict>

export const ticketSchema = z.object({
  id: z.string(),
  key: z.string(),
  project: z.string(),
  title: z.string(),
  body: z.string(),
  status: statusSchema,
  priority: prioritySchema,
  assignee: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  seq: sequenceSchema,
}) satisfies z.ZodType<Ticket>

export const commentSchema = z.object({
  id: z.string(),
  ticket_id: z.string(),
  body: z.string(),
  member_id: z.string(),
  token_id: z.string(),
  token_kind: z.enum(TokenKind),
  agent_name: z.string().nullable(),
  delegating_member_id: z.string().nullable(),
  created_at: z.string(),
  seq: sequenceSchema,
}) satisfies z.ZodType<Comment>

export const projectSchema = z.object({
  id: z.string(),
  key: z.string(),
  display_name: z.string(),
  description: projectDescriptionSchema,
  owner_ids: z.array(z.string()),
  created_at: z.string(),
  updated_at: z.string(),
  seq: sequenceSchema,
}) satisfies z.ZodType<Project>

export const ticketTombstoneSchema = z.object({
  id: z.string(),
  key: z.string(),
  seq: sequenceSchema,
}) satisfies z.ZodType<TicketTombstone>

export const projectTombstoneSchema = z.object({
  id: z.string(),
  key: z.string(),
  seq: sequenceSchema,
}) satisfies z.ZodType<ProjectTombstone>

export const memberProfileSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: roleSchema,
  status: memberStatusSchema,
  created_at: z.string(),
  activated_at: z.string().nullable(),
}) satisfies z.ZodType<MemberProfile>

export const syncResponseSchema = z.object({
  applied: z.array(appliedMutationSchema),
  conflicts: z.array(mutationConflictSchema),
  deltas: z.array(ticketSchema),
  comment_deltas: z.array(commentSchema),
  project_deltas: z.array(projectSchema).optional(),
  tombstones: z.array(ticketTombstoneSchema).optional(),
  project_tombstones: z.array(projectTombstoneSchema).optional(),
  members: z.array(memberProfileSchema).optional(),
  latest_seq: sequenceSchema,
}) satisfies z.ZodType<SyncResponse>

export const snapshotSchema = z.object({
  projects: z.array(projectSchema),
  tickets: z.array(ticketSchema),
  comments: z.array(commentSchema),
  members: z.array(memberProfileSchema).optional(),
  latest_seq: sequenceSchema,
}) satisfies z.ZodType<Snapshot>
