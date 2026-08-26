import { z } from 'zod'

import {
  Entity,
  MemberStatus,
  MutationOp,
  Priority,
  Role,
  Status,
  type AppliedMutation,
  type MemberProfile,
  type Mutation,
  type MutationConflict,
  type Snapshot,
  type SyncRequest,
  type SyncResponse,
  type Ticket,
  type TicketSet,
  type TicketTombstone,
} from './schema.gen'

export const MAX_SEQUENCE = 0xffff_ffff

export const sequenceSchema = z.number().int().min(0).max(MAX_SEQUENCE)
export const roleSchema = z.enum(Role)
export const memberStatusSchema = z.enum(MemberStatus)
export const mutationOpSchema = z.enum(MutationOp)
export const statusSchema = z.enum(Status)
export const prioritySchema = z.enum(Priority)

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

export const ticketSetSchema = z
  .object({
    title: z.string().optional(),
    status: statusSchema.optional(),
    priority: prioritySchema.optional(),
    assignee: z.string().nullable().optional(),
    body: z.string().optional(),
  })
  .strict() satisfies z.ZodType<TicketSet>

export const ticketSetInputSchema = z
  .object({
    title: optionalStringSchema,
    status: optionalStatusSchema,
    priority: optionalPrioritySchema,
    assignee: z.string().nullable().optional(),
    body: optionalStringSchema,
  })
  .strict() satisfies z.ZodType<TicketSet>

const mutationBaseShape = {
  mutation_id: z.string().min(1),
  entity: z.literal(Entity.Ticket),
  entity_id: z.string().min(1),
}

const createMutationSchema = z.object({
  ...mutationBaseShape,
  op: z.literal(MutationOp.Create),
  base_seq: z.undefined().optional(),
  set: ticketSetSchema,
})

const updateMutationSchema = z.object({
  ...mutationBaseShape,
  op: z.literal(MutationOp.Update),
  base_seq: sequenceSchema,
  set: ticketSetSchema,
})

const deleteMutationSchema = z.object({
  ...mutationBaseShape,
  op: z.literal(MutationOp.Delete),
  base_seq: sequenceSchema,
  set: ticketSetSchema,
})

export const mutationSchema = z.discriminatedUnion('op', [
  createMutationSchema,
  updateMutationSchema,
  deleteMutationSchema,
]) satisfies z.ZodType<Mutation>

const createMutationInputSchema = createMutationSchema.extend({
  set: ticketSetInputSchema.optional().default({}),
})

const updateMutationInputSchema = updateMutationSchema.extend({
  set: ticketSetInputSchema.optional().default({}),
})

const deleteMutationInputSchema = deleteMutationSchema.extend({
  set: ticketSetInputSchema.optional().default({}),
})

export const mutationInputSchema = z.discriminatedUnion('op', [
  createMutationInputSchema,
  updateMutationInputSchema,
  deleteMutationInputSchema,
]) satisfies z.ZodType<Mutation>

export const mutationRecordSchema = z.looseObject({})

export const mutationIdentitySchema = z.object({
  mutation_id: z.string().catch(''),
  entity_id: z.string().catch(''),
})

export const mutationAuthorizationSchema = z.object({
  mutation_id: z.string().min(1),
  entity_id: z.string().catch(''),
  entity: z.literal(Entity.Ticket),
  op: mutationOpSchema,
})

export const syncEnvelopeSchema = z.object({
  protocol_version: z.literal(1),
  last_seq: sequenceSchema,
  mutations: z.array(z.unknown()),
})

export const syncRequestSchema = z.object({
  protocol_version: z.literal(1),
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
  title: z.string(),
  body: z.string(),
  status: statusSchema,
  priority: prioritySchema,
  assignee: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  seq: sequenceSchema,
}) satisfies z.ZodType<Ticket>

export const ticketTombstoneSchema = z.object({
  id: z.string(),
  key: z.string(),
  seq: sequenceSchema,
}) satisfies z.ZodType<TicketTombstone>

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
  tombstones: z.array(ticketTombstoneSchema).optional(),
  members: z.array(memberProfileSchema).optional(),
  latest_seq: sequenceSchema,
}) satisfies z.ZodType<SyncResponse>

export const snapshotSchema = z.object({
  tickets: z.array(ticketSchema),
  members: z.array(memberProfileSchema).optional(),
  latest_seq: sequenceSchema,
}) satisfies z.ZodType<Snapshot>
