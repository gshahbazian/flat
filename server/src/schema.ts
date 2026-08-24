/* Generated from Rust (schema/src/lib.rs) via npm run codegen. Do not edit. */

export type Priority = "none" | "low" | "medium" | "high" | "urgent";
export type Status = "backlog" | "todo" | "in_progress" | "in_review" | "done" | "canceled";
export type EntityKind = "ticket" | "comment" | "project" | "member" | "label";
export type Op = "create" | "update" | "delete";
export type DeltaOp = "upsert" | "delete";

/**
 * Generated from Rust (schema/src/lib.rs). Do not edit.
 */
export interface FlatProtocol {
  project: Project;
  ticket: Ticket;
  comment: Comment;
  member: Member;
  label: Label;
  mutation: Mutation;
  sync_request: SyncRequest;
  sync_response: SyncResponse;
  snapshot: Snapshot;
  error_response: ErrorResponse;
}
export interface Project {
  created: string;
  /**
   * Immutable ULID.
   */
  id: string;
  /**
   * Human-facing key, `^[A-Z][A-Z0-9]{1,7}$`, immutable in v1.
   */
  key: string;
  /**
   * Display name; renames freely.
   */
  name: string;
  /**
   * Optional owner emails.
   */
  owners: string[];
  /**
   * Mutation-log seq of the last change to this entity.
   */
  seq: number;
  updated: string;
  [k: string]: unknown;
}
export interface Ticket {
  /**
   * Assignee email, or null.
   */
  assignee?: string | null;
  created: string;
  /**
   * Freeform markdown body.
   */
  description: string;
  /**
   * Immutable ULID.
   */
  id: string;
  /**
   * Human-facing key alias, e.g. `AUTH-142`.
   */
  key: string;
  labels: string[];
  /**
   * Per-project counter, from 1, never reused.
   */
  number: number;
  priority: Priority;
  project_id: string;
  /**
   * Mutation-log seq of the last change to this entity.
   */
  seq: number;
  status: Status;
  title: string;
  updated: string;
  [k: string]: unknown;
}
export interface Comment {
  /**
   * Author email (the token owner, or the agent's name).
   */
  author: string;
  body: string;
  created: string;
  /**
   * Immutable ULID.
   */
  id: string;
  /**
   * When an agent token acts for a human, the human's email.
   */
  on_behalf_of?: string | null;
  seq: number;
  ticket_id: string;
  [k: string]: unknown;
}
export interface Member {
  created: string;
  email: string;
  /**
   * Immutable ULID.
   */
  id: string;
  name?: string | null;
  seq: number;
  [k: string]: unknown;
}
export interface Label {
  created: string;
  /**
   * Immutable ULID.
   */
  id: string;
  name: string;
  seq: number;
  [k: string]: unknown;
}
/**
 * One client write. Atomic per entity: if any field conflicts, nothing in this mutation applies (other mutations in the same push still can).
 */
export interface Mutation {
  /**
   * The seq the client last saw for this entity. Conflict = a field the server changed since then.
   */
  base_seq: number;
  entity: EntityKind;
  /**
   * Entity ULID. For `create`, the client generates it.
   */
  entity_id: string;
  /**
   * List fields (labels) travel as add/remove deltas so concurrent taggers don't clobber each other.
   */
  labels_add?: string[];
  labels_remove?: string[];
  /**
   * Client-generated ULID; the server's idempotency key. Replaying a mutation_id returns the original result instead of double-applying.
   */
  mutation_id: string;
  op: Op;
  /**
   * Scalar fields: last-value set.
   */
  set?: {
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
export interface SyncRequest {
  /**
   * Highest seq the client has applied locally; deltas above this come back in the response.
   */
  last_seq: number;
  mutations?: Mutation[];
  protocol_version: number;
  [k: string]: unknown;
}
export interface SyncResponse {
  applied: AppliedMutation[];
  conflicts: Conflict[];
  deltas: Delta[];
  latest_seq: number;
  rejected: Rejected[];
  [k: string]: unknown;
}
export interface AppliedMutation {
  entity_id: string;
  /**
   * For creates of keyed entities: the assigned key, e.g. `AUTH-142`.
   */
  key?: string | null;
  mutation_id: string;
  /**
   * Seq stamped on this change (unchanged entity seq for a no-op).
   */
  seq: number;
  [k: string]: unknown;
}
export interface Conflict {
  entity_id: string;
  /**
   * Fields the server changed since the mutation's base_seq that the mutation also tried to set.
   */
  fields: string[];
  mutation_id: string;
  /**
   * Current server state of the entity.
   */
  server: {
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
export interface Delta {
  data?: unknown;
  entity: EntityKind;
  entity_id: string;
  /**
   * `upsert` carries the full entity in `data`; `delete` carries null.
   */
  op: DeltaOp;
  seq: number;
  [k: string]: unknown;
}
/**
 * A mutation the server refused for a reason other than a conflict (validation error, unknown entity, read-only field, ...).
 */
export interface Rejected {
  entity_id: string;
  error: string;
  mutation_id: string;
  [k: string]: unknown;
}
export interface Snapshot {
  comments: Comment[];
  labels: Label[];
  /**
   * The seq watermark this snapshot represents.
   */
  latest_seq: number;
  members: Member[];
  /**
   * Pagination cursor; null when this page is the last.
   */
  next_cursor?: string | null;
  projects: Project[];
  tickets: Ticket[];
  [k: string]: unknown;
}
/**
 * Non-2xx responses carry this body. `error` is a stable machine-readable code; the compaction clause uses `resync_required` (client's last_seq predates the server's compaction floor -> take a fresh snapshot).
 */
export interface ErrorResponse {
  error: string;
  message: string;
  [k: string]: unknown;
}
