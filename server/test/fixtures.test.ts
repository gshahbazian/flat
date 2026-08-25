// Round-trips every schema fixture through the generated TypeScript types:
// parse the JSON into a typed value field-by-field (rejecting wrong types and
// unknown fields), then require the typed value to deep-equal the fixture.
// The Rust twin of this test is schema/tests/fixtures.rs.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  Entity,
  MutationOp,
  MemberStatus,
  Role,
  Status,
  type AppliedMutation,
  type Mutation,
  type MutationConflict,
  type MemberProfile,
  type Snapshot,
  type SyncRequest,
  type SyncResponse,
  type Ticket,
  type TicketSet,
} from "../src/schema.gen";
import { invalidEmail, invalidTitle } from "../src/validate";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../schema/fixtures/${name}.json`, import.meta.url), "utf8"));
}

type Raw = Record<string, unknown>;

function obj(v: unknown, allowedKeys: string[]): Raw {
  expect(v).toBeTypeOf("object");
  expect(v).not.toBeNull();
  const raw = v as Raw;
  expect(allowedKeys).toEqual(expect.arrayContaining(Object.keys(raw)));
  return raw;
}

function str(v: unknown): string {
  expect(v).toBeTypeOf("string");
  return v as string;
}

function num(v: unknown): number {
  expect(v).toBeTypeOf("number");
  return v as number;
}

function oneOf<T extends string>(v: unknown, values: T[]): T {
  expect(values).toContain(v);
  return v as T;
}

function ticket(v: unknown): Ticket {
  const raw = obj(v, ["id", "key", "title", "body", "status", "seq"]);
  return {
    id: str(raw.id),
    key: str(raw.key),
    title: str(raw.title),
    body: str(raw.body),
    status: oneOf(raw.status, Object.values(Status)),
    seq: num(raw.seq),
  };
}

function ticketSet(v: unknown): TicketSet {
  const raw = obj(v, ["title", "status", "body"]);
  return {
    title: raw.title === undefined ? undefined : str(raw.title),
    status: raw.status === undefined ? undefined : oneOf(raw.status, Object.values(Status)),
    body: raw.body === undefined ? undefined : str(raw.body),
  };
}

function mutation(v: unknown): Mutation {
  const raw = obj(v, ["mutation_id", "op", "entity", "entity_id", "base_seq", "set"]);
  return {
    mutation_id: str(raw.mutation_id),
    op: oneOf(raw.op, Object.values(MutationOp)),
    entity: oneOf(raw.entity, Object.values(Entity)),
    entity_id: str(raw.entity_id),
    base_seq: raw.base_seq === undefined ? undefined : num(raw.base_seq),
    set: ticketSet(raw.set),
  };
}

function syncRequest(v: unknown): SyncRequest {
  const raw = obj(v, ["protocol_version", "last_seq", "mutations"]);
  expect(raw.mutations).toBeInstanceOf(Array);
  return {
    protocol_version: num(raw.protocol_version),
    last_seq: num(raw.last_seq),
    mutations: (raw.mutations as unknown[]).map(mutation),
  };
}

function appliedMutation(v: unknown): AppliedMutation {
  const raw = obj(v, ["mutation_id", "entity_id", "key", "seq"]);
  return {
    mutation_id: str(raw.mutation_id),
    entity_id: str(raw.entity_id),
    key: str(raw.key),
    seq: num(raw.seq),
  };
}

function mutationConflict(v: unknown): MutationConflict {
  const raw = obj(v, ["mutation_id", "entity_id", "reason"]);
  return {
    mutation_id: str(raw.mutation_id),
    entity_id: str(raw.entity_id),
    reason: str(raw.reason),
  };
}

function member(v: unknown): MemberProfile {
  const raw = obj(v, ["id", "email", "role", "status", "created_at", "activated_at"]);
  return {
    id: str(raw.id),
    email: str(raw.email),
    role: oneOf(raw.role, Object.values(Role)),
    status: oneOf(raw.status, Object.values(MemberStatus)),
    created_at: str(raw.created_at),
    activated_at: raw.activated_at === null ? null : str(raw.activated_at),
  };
}

function syncResponse(v: unknown): SyncResponse {
  const raw = obj(v, ["applied", "conflicts", "deltas", "members", "latest_seq"]);
  expect(raw.applied).toBeInstanceOf(Array);
  expect(raw.conflicts).toBeInstanceOf(Array);
  expect(raw.deltas).toBeInstanceOf(Array);
  return {
    applied: (raw.applied as unknown[]).map(appliedMutation),
    conflicts: (raw.conflicts as unknown[]).map(mutationConflict),
    deltas: (raw.deltas as unknown[]).map(ticket),
    members: (raw.members as unknown[]).map(member),
    latest_seq: num(raw.latest_seq),
  };
}

function snapshot(v: unknown): Snapshot {
  const raw = obj(v, ["tickets", "members", "latest_seq"]);
  expect(raw.tickets).toBeInstanceOf(Array);
  return {
    tickets: (raw.tickets as unknown[]).map(ticket),
    members: (raw.members as unknown[]).map(member),
    latest_seq: num(raw.latest_seq),
  };
}

describe("schema fixtures round-trip through the generated types", () => {
  test("ticket", () => {
    expect(ticket(fixture("ticket"))).toEqual(fixture("ticket"));
  });

  test("mutation", () => {
    expect(mutation(fixture("mutation"))).toEqual(fixture("mutation"));
  });

  test("sync_request", () => {
    expect(syncRequest(fixture("sync_request"))).toEqual(fixture("sync_request"));
  });

  test("sync_response", () => {
    expect(syncResponse(fixture("sync_response"))).toEqual(fixture("sync_response"));
  });

  test("snapshot", () => {
    expect(snapshot(fixture("snapshot"))).toEqual(fixture("snapshot"));
  });
});

// The Rust twin (flat_schema::validate_title) runs this same fixture in
// schema/tests/fixtures.rs, keeping the two implementations in lockstep.
describe("title rule matches the Rust rule", () => {
  const titles = fixture("titles") as { valid: string[]; invalid: string[] };

  test("valid titles pass", () => {
    for (const title of titles.valid) {
      expect(invalidTitle(title), JSON.stringify(title)).toBeNull();
    }
  });

  test("invalid titles are rejected", () => {
    for (const title of titles.invalid) {
      expect(invalidTitle(title), JSON.stringify(title)).not.toBeNull();
    }
  });
});

describe("email rule matches the Rust rule", () => {
  const emails = fixture("emails") as {
    valid: Array<{ input: string; normalized: string }>;
    invalid: string[];
  };

  test("valid emails normalize", () => {
    for (const email of emails.valid) expect(invalidEmail(email.input)).toBe(email.normalized);
  });

  test("invalid emails reject", () => {
    for (const email of emails.invalid) expect(invalidEmail(email)).toBeNull();
  });
});
