// Field-level conflict detection for ticket updates.
//
// A stale base_seq is not by itself a conflict: the client may have edited
// fields the server hasn't touched since. The tenant DO replays the mutation
// log after base_seq to find which fields the server changed; the mutation is
// rejected (whole — mutations are atomic per ticket) only when it sets a
// field the server also changed. The CLI resolves rejections client-side,
// where the base copy lives: `flat sync --merge`.
import type { MutationSet } from './schema.gen'

export const TICKET_FIELDS = ['title', 'status', 'priority', 'assignee', 'body'] as const
export type TicketField = (typeof TICKET_FIELDS)[number]

export function fieldsSet(set: MutationSet | null | undefined): TicketField[] {
  if (!set) return []
  return TICKET_FIELDS.filter((field) => {
    if (field === 'assignee') return Object.hasOwn(set, field)
    return set[field] != null
  })
}

/** Fields the incoming `set` touches that any of `serverSets` also touched. */
export function conflictingFields(
  incoming: MutationSet,
  serverSets: (MutationSet | null | undefined)[]
): TicketField[] {
  const changed = new Set(serverSets.flatMap(fieldsSet))
  return fieldsSet(incoming).filter((field) => changed.has(field))
}
