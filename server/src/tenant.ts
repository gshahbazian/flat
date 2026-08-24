// The tenant Durable Object: all tables plus one global ordered mutation
// log. A single DO serializes every write and stamps it with a monotonically
// increasing `seq`, which also makes per-project ticket counters trivial.

import { DurableObject } from "cloudflare:workers";
import type {
  AppliedMutation,
  Comment,
  Conflict,
  Delta,
  Label,
  Member,
  Mutation,
  Priority,
  Project,
  Rejected,
  Snapshot,
  Status,
  SyncRequest,
  SyncResponse,
  Ticket,
} from "./schema";

const MIN_PROTOCOL_VERSION = 1;
const STATUSES = ["backlog", "todo", "in_progress", "in_review", "done", "canceled"];
const PRIORITIES = ["none", "low", "medium", "high", "urgent"];
const PROJECT_KEY_RE = /^[A-Z][A-Z0-9]{1,7}$/;

/** Ticket fields a client may `set` on update. */
const TICKET_FIELDS = ["title", "status", "priority", "assignee", "description"];
/** Extra fields allowed on create only. */
const TICKET_CREATE_FIELDS = [...TICKET_FIELDS, "project_id"];

/** Validation failure: the mutation lands in `rejected`. */
class Reject extends Error {}

/** A field the server changed since base_seq: the mutation lands in
 * `conflicts` and nothing in it applies (atomic per entity). */
class ConflictError extends Error {
  constructor(
    public fields: string[],
    public server: unknown,
  ) {
    super("conflict");
  }
}

type Row = Record<string, SqlStorageValue>;

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: code, message }, { status });
}

function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function isUlid(v: unknown): v is string {
  return typeof v === "string" && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(v);
}

function requireString(set: Record<string, unknown>, field: string): string {
  const v = set[field];
  if (typeof v !== "string" || v.length === 0) throw new Reject(`${field} must be a non-empty string`);
  return v;
}

function optionalString(v: unknown, field: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new Reject(`${field} must be a string or null`);
  return v;
}

function parseStatus(v: unknown): Status {
  if (typeof v !== "string" || !STATUSES.includes(v)) throw new Reject(`unknown status: ${String(v)}`);
  return v as Status;
}

function parsePriority(v: unknown): Priority {
  if (typeof v !== "string" || !PRIORITIES.includes(v)) throw new Reject(`unknown priority: ${String(v)}`);
  return v as Priority;
}

function parseStringArray(v: unknown, field: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new Reject(`${field} must be an array of strings`);
  }
  return v as string[];
}

export class Tenant extends DurableObject<unknown> {
  sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        key TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        owners TEXT NOT NULL DEFAULT '[]',
        next_number INTEGER NOT NULL DEFAULT 1,
        created TEXT NOT NULL,
        updated TEXT NOT NULL,
        seq INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS tickets (
        id TEXT PRIMARY KEY,
        key TEXT UNIQUE NOT NULL,
        project_id TEXT NOT NULL,
        number INTEGER NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        assignee TEXT,
        labels TEXT NOT NULL DEFAULT '[]',
        description TEXT NOT NULL DEFAULT '',
        created TEXT NOT NULL,
        updated TEXT NOT NULL,
        seq INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL,
        author TEXT NOT NULL,
        on_behalf_of TEXT,
        body TEXT NOT NULL,
        created TEXT NOT NULL,
        seq INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS members (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        name TEXT,
        created TEXT NOT NULL,
        seq INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS labels (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        created TEXT NOT NULL,
        seq INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS mutation_log (
        seq INTEGER PRIMARY KEY,
        mutation_id TEXT NOT NULL,
        entity TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        op TEXT NOT NULL,
        changed_fields TEXT NOT NULL,
        payload TEXT NOT NULL,
        ts TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mutation_log_entity ON mutation_log (entity_id, seq);
      CREATE TABLE IF NOT EXISTS applied_mutations (
        mutation_id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        result TEXT NOT NULL
      );
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/sync") {
      let body: SyncRequest;
      try {
        body = (await request.json()) as SyncRequest;
      } catch {
        return errorResponse(400, "bad_request", "body must be JSON");
      }
      return this.handleSync(body);
    }
    if (request.method === "GET" && url.pathname === "/snapshot") {
      return this.handleSnapshot();
    }
    return errorResponse(404, "not_found", `no route for ${request.method} ${url.pathname}`);
  }

  // -------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------

  handleSync(req: SyncRequest): Response {
    if (typeof req.protocol_version !== "number" || req.protocol_version < MIN_PROTOCOL_VERSION) {
      return errorResponse(
        400,
        "unsupported_protocol",
        `protocol_version ${req.protocol_version} is below the server minimum ${MIN_PROTOCOL_VERSION}`,
      );
    }
    const lastSeq = typeof req.last_seq === "number" ? req.last_seq : 0;
    // Compaction clause: encoded now, exercised never in v1 (floor stays 0).
    const floor = this.metaInt("compaction_floor");
    if (lastSeq < floor) {
      return errorResponse(
        409,
        "resync_required",
        `last_seq ${lastSeq} predates the compaction floor ${floor}; take a fresh snapshot`,
      );
    }

    const applied: AppliedMutation[] = [];
    const conflicts: Conflict[] = [];
    const rejected: Rejected[] = [];
    for (const m of req.mutations ?? []) {
      try {
        applied.push(this.ctx.storage.transactionSync(() => this.applyMutation(m)));
      } catch (e) {
        if (e instanceof ConflictError) {
          conflicts.push({
            mutation_id: m.mutation_id,
            entity_id: m.entity_id,
            fields: e.fields,
            server: e.server as Conflict["server"],
          });
        } else if (e instanceof Reject) {
          rejected.push({ mutation_id: m.mutation_id, entity_id: m.entity_id, error: e.message });
        } else {
          throw e;
        }
      }
    }

    const response: SyncResponse = {
      applied,
      conflicts,
      rejected,
      deltas: this.deltasSince(lastSeq),
      latest_seq: this.metaInt("latest_seq"),
    };
    return Response.json(response);
  }

  handleSnapshot(): Response {
    const snapshot: Snapshot = {
      latest_seq: this.metaInt("latest_seq"),
      projects: this.rows("projects").map((r) => this.projectToWire(r)),
      tickets: this.rows("tickets").map((r) => this.ticketToWire(r)),
      comments: this.rows("comments").map((r) => this.commentToWire(r)),
      members: this.rows("members").map((r) => this.memberToWire(r)),
      labels: this.rows("labels").map((r) => this.labelToWire(r)),
      next_cursor: null,
    };
    return Response.json(snapshot);
  }

  // -------------------------------------------------------------------------
  // Mutation dispatch
  // -------------------------------------------------------------------------

  applyMutation(m: Mutation): AppliedMutation {
    if (!isUlid(m.mutation_id)) throw new Reject("mutation_id must be a ULID");
    if (!isUlid(m.entity_id)) throw new Reject("entity_id must be a ULID");

    // Idempotency: a replayed mutation_id returns the original result
    // instead of double-applying. Kept forever in v1.
    const prior = this.one("SELECT result FROM applied_mutations WHERE mutation_id = ?", m.mutation_id);
    if (prior) return JSON.parse(prior.result as string) as AppliedMutation;

    const result = this.dispatch(m);
    this.sql.exec(
      "INSERT INTO applied_mutations (mutation_id, seq, result) VALUES (?, ?, ?)",
      m.mutation_id,
      result.seq,
      JSON.stringify(result),
    );
    return result;
  }

  dispatch(m: Mutation): AppliedMutation {
    switch (`${m.entity}:${m.op}`) {
      case "ticket:create":
        return this.createTicket(m);
      case "ticket:update":
        return this.updateTicket(m);
      case "ticket:delete":
        return this.deleteTicket(m);
      case "project:create":
        return this.createProject(m);
      case "project:update":
        return this.updateProject(m);
      case "comment:create":
        return this.createComment(m);
      case "comment:update":
      case "comment:delete":
        throw new Reject("comments are read-only — use `flat comment`");
      case "member:create":
        return this.createMember(m);
      case "label:create":
        return this.createLabel(m);
      default:
        throw new Reject(`${m.op} ${m.entity} is not supported in v1`);
    }
  }

  // -------------------------------------------------------------------------
  // Tickets
  // -------------------------------------------------------------------------

  createTicket(m: Mutation): AppliedMutation {
    const set = (m.set ?? {}) as Record<string, unknown>;
    for (const k of Object.keys(set)) {
      if (!TICKET_CREATE_FIELDS.includes(k)) throw new Reject(`unknown ticket field: ${k}`);
    }
    if (this.one("SELECT id FROM tickets WHERE id = ?", m.entity_id)) {
      throw new Reject(`ticket ${m.entity_id} already exists`);
    }
    const projectId = requireString(set, "project_id");
    const project = this.one("SELECT * FROM projects WHERE id = ? AND deleted = 0", projectId);
    if (!project) throw new Reject(`unknown project_id: ${projectId}`);
    const title = requireString(set, "title");
    const status = set.status === undefined ? "todo" : parseStatus(set.status);
    const priority = set.priority === undefined ? "none" : parsePriority(set.priority);
    const assignee = optionalString(set.assignee, "assignee");
    const description = set.description === undefined ? "" : (optionalString(set.description, "description") ?? "");
    const labels = [...new Set(parseStringArray(m.labels_add, "labels_add"))];

    const number = Number(project.next_number);
    const key = `${project.key as string}-${number}`;
    this.sql.exec("UPDATE projects SET next_number = ? WHERE id = ?", number + 1, projectId);

    const seq = this.allocSeq();
    const ts = now();
    this.sql.exec(
      `INSERT INTO tickets (id, key, project_id, number, title, status, priority, assignee, labels, description, created, updated, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      m.entity_id,
      key,
      projectId,
      number,
      title,
      status,
      priority,
      assignee,
      JSON.stringify(labels),
      description,
      ts,
      ts,
      seq,
    );
    this.log(seq, m, ["*"]);
    return { mutation_id: m.mutation_id, entity_id: m.entity_id, seq, key };
  }

  updateTicket(m: Mutation): AppliedMutation {
    const t = this.one("SELECT * FROM tickets WHERE id = ? AND deleted = 0", m.entity_id);
    if (!t) throw new Reject(`unknown ticket: ${m.entity_id}`);
    const set = (m.set ?? {}) as Record<string, unknown>;

    // Validate and normalize: drop fields already at the requested value, so
    // two agents setting the same status don't conflict.
    const effective: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(set)) {
      if (!TICKET_FIELDS.includes(k)) throw new Reject(`${k} is not an editable ticket field`);
      let value: string | null;
      if (k === "status") value = parseStatus(v);
      else if (k === "priority") value = parsePriority(v);
      else if (k === "assignee") value = optionalString(v, k);
      else if (k === "title") value = requireString(set, k);
      else value = optionalString(v, k) ?? "";
      if (value !== (t[k] ?? null)) effective[k] = value;
    }
    const labels = JSON.parse(t.labels as string) as string[];
    const labelsAdd = parseStringArray(m.labels_add, "labels_add").filter((l) => !labels.includes(l));
    const labelsRemove = parseStringArray(m.labels_remove, "labels_remove").filter((l) => labels.includes(l));

    // Field-level conflict detection: what has the server changed since the
    // client's base_seq? Label add/remove deltas commute and never conflict.
    const changed = this.changedFieldsSince(m.entity_id, m.base_seq ?? 0);
    const conflictFields = Object.keys(effective).filter((k) => changed.has("*") || changed.has(k));
    if (conflictFields.length > 0) {
      throw new ConflictError(conflictFields.sort(), this.ticketToWire(t));
    }

    const labelsChanged = labelsAdd.length > 0 || labelsRemove.length > 0;
    if (Object.keys(effective).length === 0 && !labelsChanged) {
      // No-op: everything already matches; nothing to log.
      return { mutation_id: m.mutation_id, entity_id: m.entity_id, seq: Number(t.seq), key: null };
    }

    const newLabels = [...labels.filter((l) => !labelsRemove.includes(l)), ...labelsAdd];
    const seq = this.allocSeq();
    const assignments: string[] = ["labels = ?", "updated = ?", "seq = ?"];
    const bindings: SqlStorageValue[] = [JSON.stringify(newLabels), now(), seq];
    for (const [k, v] of Object.entries(effective)) {
      assignments.push(`${k} = ?`);
      bindings.push(v);
    }
    this.sql.exec(`UPDATE tickets SET ${assignments.join(", ")} WHERE id = ?`, ...bindings, m.entity_id);

    const changedFields = Object.keys(effective);
    if (labelsChanged) changedFields.push("labels");
    this.log(seq, m, changedFields);
    return { mutation_id: m.mutation_id, entity_id: m.entity_id, seq, key: null };
  }

  deleteTicket(m: Mutation): AppliedMutation {
    const t = this.one("SELECT * FROM tickets WHERE id = ? AND deleted = 0", m.entity_id);
    if (!t) throw new Reject(`unknown ticket: ${m.entity_id}`);
    const seq = this.allocSeq();
    this.sql.exec("UPDATE tickets SET deleted = 1, updated = ?, seq = ? WHERE id = ?", now(), seq, m.entity_id);
    this.log(seq, m, ["*"]);
    return { mutation_id: m.mutation_id, entity_id: m.entity_id, seq, key: null };
  }

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------

  createProject(m: Mutation): AppliedMutation {
    const set = (m.set ?? {}) as Record<string, unknown>;
    for (const k of Object.keys(set)) {
      if (!["key", "name", "owners"].includes(k)) throw new Reject(`unknown project field: ${k}`);
    }
    const key = requireString(set, "key");
    if (!PROJECT_KEY_RE.test(key)) throw new Reject(`project key must match ${PROJECT_KEY_RE}`);
    const name = requireString(set, "name");
    const owners = parseStringArray(set.owners, "owners");
    if (this.one("SELECT id FROM projects WHERE id = ?", m.entity_id)) {
      throw new Reject(`project ${m.entity_id} already exists`);
    }
    if (this.one("SELECT id FROM projects WHERE key = ?", key)) {
      throw new Reject(`project key ${key} is taken`);
    }
    const seq = this.allocSeq();
    const ts = now();
    this.sql.exec(
      "INSERT INTO projects (id, key, name, owners, next_number, created, updated, seq) VALUES (?, ?, ?, ?, 1, ?, ?, ?)",
      m.entity_id,
      key,
      name,
      JSON.stringify(owners),
      ts,
      ts,
      seq,
    );
    this.log(seq, m, ["*"]);
    return { mutation_id: m.mutation_id, entity_id: m.entity_id, seq, key };
  }

  updateProject(m: Mutation): AppliedMutation {
    const p = this.one("SELECT * FROM projects WHERE id = ? AND deleted = 0", m.entity_id);
    if (!p) throw new Reject(`unknown project: ${m.entity_id}`);
    const set = (m.set ?? {}) as Record<string, unknown>;
    const effective: Record<string, string> = {};
    for (const [k, v] of Object.entries(set)) {
      if (k === "name") {
        const name = requireString(set, "name");
        if (name !== p.name) effective.name = name;
      } else if (k === "owners") {
        const owners = JSON.stringify(parseStringArray(v, "owners"));
        if (owners !== p.owners) effective.owners = owners;
      } else if (k === "key") {
        throw new Reject("project keys are immutable in v1");
      } else {
        throw new Reject(`unknown project field: ${k}`);
      }
    }
    const changed = this.changedFieldsSince(m.entity_id, m.base_seq ?? 0);
    const conflictFields = Object.keys(effective).filter((k) => changed.has("*") || changed.has(k));
    if (conflictFields.length > 0) {
      throw new ConflictError(conflictFields.sort(), this.projectToWire(p));
    }
    if (Object.keys(effective).length === 0) {
      return { mutation_id: m.mutation_id, entity_id: m.entity_id, seq: Number(p.seq), key: null };
    }
    const seq = this.allocSeq();
    const assignments = ["updated = ?", "seq = ?"];
    const bindings: SqlStorageValue[] = [now(), seq];
    for (const [k, v] of Object.entries(effective)) {
      assignments.push(`${k} = ?`);
      bindings.push(v);
    }
    this.sql.exec(`UPDATE projects SET ${assignments.join(", ")} WHERE id = ?`, ...bindings, m.entity_id);
    this.log(seq, m, Object.keys(effective));
    return { mutation_id: m.mutation_id, entity_id: m.entity_id, seq, key: null };
  }

  // -------------------------------------------------------------------------
  // Comments / members / labels
  // -------------------------------------------------------------------------

  createComment(m: Mutation): AppliedMutation {
    const set = (m.set ?? {}) as Record<string, unknown>;
    for (const k of Object.keys(set)) {
      if (!["ticket_id", "body", "author", "on_behalf_of"].includes(k)) {
        throw new Reject(`unknown comment field: ${k}`);
      }
    }
    const ticketId = requireString(set, "ticket_id");
    if (!this.one("SELECT id FROM tickets WHERE id = ? AND deleted = 0", ticketId)) {
      throw new Reject(`unknown ticket: ${ticketId}`);
    }
    const body = requireString(set, "body");
    const author = requireString(set, "author");
    const onBehalfOf = optionalString(set.on_behalf_of, "on_behalf_of");
    if (this.one("SELECT id FROM comments WHERE id = ?", m.entity_id)) {
      throw new Reject(`comment ${m.entity_id} already exists`);
    }
    const seq = this.allocSeq();
    this.sql.exec(
      "INSERT INTO comments (id, ticket_id, author, on_behalf_of, body, created, seq) VALUES (?, ?, ?, ?, ?, ?, ?)",
      m.entity_id,
      ticketId,
      author,
      onBehalfOf,
      body,
      now(),
      seq,
    );
    this.log(seq, m, ["*"]);
    return { mutation_id: m.mutation_id, entity_id: m.entity_id, seq, key: null };
  }

  createMember(m: Mutation): AppliedMutation {
    const set = (m.set ?? {}) as Record<string, unknown>;
    const email = requireString(set, "email");
    const name = optionalString(set.name, "name");
    if (this.one("SELECT id FROM members WHERE email = ?", email)) {
      throw new Reject(`member ${email} already exists`);
    }
    const seq = this.allocSeq();
    this.sql.exec(
      "INSERT INTO members (id, email, name, created, seq) VALUES (?, ?, ?, ?, ?)",
      m.entity_id,
      email,
      name,
      now(),
      seq,
    );
    this.log(seq, m, ["*"]);
    return { mutation_id: m.mutation_id, entity_id: m.entity_id, seq, key: null };
  }

  createLabel(m: Mutation): AppliedMutation {
    const set = (m.set ?? {}) as Record<string, unknown>;
    const name = requireString(set, "name");
    if (this.one("SELECT id FROM labels WHERE name = ?", name)) {
      throw new Reject(`label ${name} already exists`);
    }
    const seq = this.allocSeq();
    this.sql.exec(
      "INSERT INTO labels (id, name, created, seq) VALUES (?, ?, ?, ?)",
      m.entity_id,
      name,
      now(),
      seq,
    );
    this.log(seq, m, ["*"]);
    return { mutation_id: m.mutation_id, entity_id: m.entity_id, seq, key: null };
  }

  // -------------------------------------------------------------------------
  // Deltas
  // -------------------------------------------------------------------------

  deltasSince(lastSeq: number): Delta[] {
    const deltas: Delta[] = [];
    const collect = (
      table: string,
      entity: Delta["entity"],
      toWire: (r: Row) => unknown,
    ) => {
      for (const r of this.sql.exec(`SELECT * FROM ${table} WHERE seq > ?`, lastSeq).toArray()) {
        deltas.push({
          seq: Number(r.seq),
          entity,
          entity_id: r.id as string,
          op: Number(r.deleted) === 1 ? "delete" : "upsert",
          data: Number(r.deleted) === 1 ? null : toWire(r),
        });
      }
    };
    collect("projects", "project", (r) => this.projectToWire(r));
    collect("tickets", "ticket", (r) => this.ticketToWire(r));
    collect("comments", "comment", (r) => this.commentToWire(r));
    collect("members", "member", (r) => this.memberToWire(r));
    collect("labels", "label", (r) => this.labelToWire(r));
    deltas.sort((a, b) => a.seq - b.seq);
    return deltas;
  }

  changedFieldsSince(entityId: string, baseSeq: number): Set<string> {
    const out = new Set<string>();
    for (const r of this.sql
      .exec("SELECT changed_fields FROM mutation_log WHERE entity_id = ? AND seq > ?", entityId, baseSeq)
      .toArray()) {
      for (const f of JSON.parse(r.changed_fields as string) as string[]) out.add(f);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Row <-> wire
  // -------------------------------------------------------------------------

  ticketToWire(r: Row): Ticket {
    return {
      id: r.id as string,
      key: r.key as string,
      project_id: r.project_id as string,
      number: Number(r.number),
      title: r.title as string,
      status: r.status as Status,
      priority: r.priority as Priority,
      assignee: (r.assignee as string | null) ?? null,
      labels: JSON.parse(r.labels as string) as string[],
      description: r.description as string,
      created: r.created as string,
      updated: r.updated as string,
      seq: Number(r.seq),
    };
  }

  projectToWire(r: Row): Project {
    return {
      id: r.id as string,
      key: r.key as string,
      name: r.name as string,
      owners: JSON.parse(r.owners as string) as string[],
      created: r.created as string,
      updated: r.updated as string,
      seq: Number(r.seq),
    };
  }

  commentToWire(r: Row): Comment {
    return {
      id: r.id as string,
      ticket_id: r.ticket_id as string,
      author: r.author as string,
      on_behalf_of: (r.on_behalf_of as string | null) ?? null,
      body: r.body as string,
      created: r.created as string,
      seq: Number(r.seq),
    };
  }

  memberToWire(r: Row): Member {
    return {
      id: r.id as string,
      email: r.email as string,
      name: (r.name as string | null) ?? null,
      created: r.created as string,
      seq: Number(r.seq),
    };
  }

  labelToWire(r: Row): Label {
    return {
      id: r.id as string,
      name: r.name as string,
      created: r.created as string,
      seq: Number(r.seq),
    };
  }

  // -------------------------------------------------------------------------
  // Storage helpers
  // -------------------------------------------------------------------------

  rows(table: string): Row[] {
    return this.sql.exec(`SELECT * FROM ${table} WHERE deleted = 0 ORDER BY seq`).toArray();
  }

  one(query: string, ...bindings: SqlStorageValue[]): Row | null {
    const rows = this.sql.exec(query, ...bindings).toArray();
    return rows.length > 0 ? rows[0] : null;
  }

  metaInt(key: string): number {
    const row = this.one("SELECT value FROM meta WHERE key = ?", key);
    return row ? Number(row.value) : 0;
  }

  allocSeq(): number {
    const next = this.metaInt("latest_seq") + 1;
    this.sql.exec(
      "INSERT INTO meta (key, value) VALUES ('latest_seq', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      String(next),
    );
    return next;
  }

  log(seq: number, m: Mutation, changedFields: string[]): void {
    this.sql.exec(
      "INSERT INTO mutation_log (seq, mutation_id, entity, entity_id, op, changed_fields, payload, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      seq,
      m.mutation_id,
      m.entity,
      m.entity_id,
      m.op,
      JSON.stringify(changedFields),
      JSON.stringify(m),
      now(),
    );
  }
}
