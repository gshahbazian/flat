// The tenant Durable Object: every table plus the one ordered mutation log.
// A single DO serializes all writes, which is what makes seq stamping and
// per-project key allocation (DEMO-1, DEMO-2, ...) trivial.
import { DurableObject } from "cloudflare:workers";
import {
  Entity,
  MutationOp,
  Status,
  type AppliedMutation,
  type Mutation,
  type MutationConflict,
  type Snapshot,
  type SyncRequest,
  type SyncResponse,
  type Ticket,
} from "./schema.gen";
import type { Env } from "./index";

export const PROTOCOL_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mutation_log (
  seq INTEGER PRIMARY KEY,
  mutation_id TEXT NOT NULL UNIQUE,
  entity_id TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS applied_mutations (
  mutation_id TEXT PRIMARY KEY,
  result TEXT NOT NULL
);
-- Seed the one DEMO project: its key and its ticket counter.
INSERT OR IGNORE INTO meta (key, value) VALUES ('project_key', 'DEMO');
INSERT OR IGNORE INTO meta (key, value) VALUES ('next_ticket_num', '1');
INSERT OR IGNORE INTO meta (key, value) VALUES ('latest_seq', '0');
`;

const STATUSES = new Set<string>(Object.values(Status));

export class TenantDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(SCHEMA);
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === "POST" && pathname === "/sync") {
      return this.handleSync(request);
    }
    if (request.method === "GET" && pathname === "/snapshot") {
      return this.handleSnapshot();
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }

  private async handleSync(request: Request): Promise<Response> {
    let req: SyncRequest;
    try {
      req = await request.json<SyncRequest>();
    } catch {
      return Response.json({ error: "body is not valid JSON" }, { status: 400 });
    }
    if (req.protocol_version !== PROTOCOL_VERSION) {
      return Response.json(
        { error: `unsupported protocol_version ${req.protocol_version} (server speaks ${PROTOCOL_VERSION})` },
        { status: 400 },
      );
    }
    if (!Array.isArray(req.mutations) || typeof req.last_seq !== "number") {
      return Response.json({ error: "malformed sync request" }, { status: 400 });
    }

    const applied: AppliedMutation[] = [];
    const conflicts: MutationConflict[] = [];
    this.ctx.storage.transactionSync(() => {
      for (const mutation of req.mutations) {
        // Idempotency: a replayed mutation_id returns the original result
        // instead of double-applying.
        const prior = this.sql
          .exec("SELECT result FROM applied_mutations WHERE mutation_id = ?", mutation.mutation_id)
          .toArray();
        if (prior.length > 0) {
          applied.push(JSON.parse(prior[0].result as string));
          continue;
        }
        const outcome = this.apply(mutation);
        if ("reason" in outcome) {
          // Conflicts are not recorded: retrying after a sync re-evaluates.
          conflicts.push(outcome);
        } else {
          this.sql.exec(
            "INSERT INTO applied_mutations (mutation_id, result) VALUES (?, ?)",
            mutation.mutation_id,
            JSON.stringify(outcome),
          );
          applied.push(outcome);
        }
      }
    });

    const response: SyncResponse = {
      applied,
      conflicts,
      deltas: this.ticketsSince(req.last_seq),
      latest_seq: this.latestSeq(),
    };
    return Response.json(response);
  }

  private handleSnapshot(): Response {
    const snapshot: Snapshot = {
      tickets: this.ticketsSince(0),
      latest_seq: this.latestSeq(),
    };
    return Response.json(snapshot);
  }

  /** Applies one mutation, or rejects it whole. Runs inside the sync transaction. */
  private apply(mutation: Mutation): AppliedMutation | MutationConflict {
    const reject = (reason: string): MutationConflict => ({
      mutation_id: mutation.mutation_id,
      entity_id: mutation.entity_id,
      reason,
    });

    if (mutation.entity !== Entity.Ticket) {
      return reject(`unknown entity ${JSON.stringify(mutation.entity)}`);
    }
    if (typeof mutation.entity_id !== "string" || mutation.entity_id.length === 0) {
      return reject("entity_id is required");
    }
    const set = mutation.set ?? {};
    for (const field of ["title", "body"] as const) {
      if (set[field] != null && typeof set[field] !== "string") {
        return reject(`set.${field} must be a string`);
      }
    }
    if (set.status != null && !STATUSES.has(set.status)) {
      return reject(`unknown status ${JSON.stringify(set.status)}`);
    }

    if (mutation.op === MutationOp.Create) {
      const exists = this.sql
        .exec("SELECT 1 FROM tickets WHERE id = ?", mutation.entity_id)
        .toArray();
      if (exists.length > 0) {
        return reject(`ticket ${mutation.entity_id} already exists`);
      }
      if (set.title == null || set.title.trim().length === 0) {
        return reject("create requires set.title");
      }
      const num = Number(this.meta("next_ticket_num"));
      const key = `${this.meta("project_key")}-${num}`;
      const seq = this.nextSeq();
      this.sql.exec(
        "INSERT INTO tickets (id, key, title, body, status, seq) VALUES (?, ?, ?, ?, ?, ?)",
        mutation.entity_id,
        key,
        set.title,
        set.body ?? "",
        set.status ?? Status.Todo,
        seq,
      );
      this.setMeta("next_ticket_num", String(num + 1));
      this.log(mutation, seq);
      return { mutation_id: mutation.mutation_id, entity_id: mutation.entity_id, key, seq };
    }

    if (mutation.op === MutationOp.Update) {
      const rows = this.sql
        .exec("SELECT key, seq FROM tickets WHERE id = ?", mutation.entity_id)
        .toArray();
      if (rows.length === 0) {
        return reject(`unknown ticket ${mutation.entity_id}`);
      }
      const { key, seq: currentSeq } = rows[0] as { key: string; seq: number };
      if (mutation.base_seq == null) {
        return reject("update requires base_seq");
      }
      if (mutation.base_seq !== currentSeq) {
        return reject(
          `stale base_seq ${mutation.base_seq} (ticket is at seq ${currentSeq}): run \`flat sync\` and retry`,
        );
      }
      const seq = this.nextSeq();
      this.sql.exec(
        `UPDATE tickets SET
           title = COALESCE(?, title),
           status = COALESCE(?, status),
           body = COALESCE(?, body),
           seq = ?
         WHERE id = ?`,
        set.title ?? null,
        set.status ?? null,
        set.body ?? null,
        seq,
        mutation.entity_id,
      );
      this.log(mutation, seq);
      return { mutation_id: mutation.mutation_id, entity_id: mutation.entity_id, key, seq };
    }

    return reject(`unknown op ${JSON.stringify(mutation.op)}`);
  }

  /** Stamps the next seq: the single ordered log every client syncs from. */
  private nextSeq(): number {
    const seq = Number(this.meta("latest_seq")) + 1;
    this.setMeta("latest_seq", String(seq));
    return seq;
  }

  private log(mutation: Mutation, seq: number): void {
    this.sql.exec(
      "INSERT INTO mutation_log (seq, mutation_id, entity_id, payload) VALUES (?, ?, ?, ?)",
      seq,
      mutation.mutation_id,
      mutation.entity_id,
      JSON.stringify(mutation),
    );
  }

  private ticketsSince(seq: number): Ticket[] {
    return this.sql
      .exec("SELECT id, key, title, body, status, seq FROM tickets WHERE seq > ? ORDER BY seq", seq)
      .toArray()
      .map((row) => ({
        id: row.id as string,
        key: row.key as string,
        title: row.title as string,
        body: row.body as string,
        status: row.status as Status,
        seq: row.seq as number,
      }));
  }

  private latestSeq(): number {
    return Number(this.meta("latest_seq"));
  }

  private meta(key: string): string {
    return this.sql.exec("SELECT value FROM meta WHERE key = ?", key).one().value as string;
  }

  private setMeta(key: string, value: string): void {
    this.sql.exec("UPDATE meta SET value = ? WHERE key = ?", value, key);
  }
}
