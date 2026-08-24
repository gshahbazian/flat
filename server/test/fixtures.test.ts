// Round-trips every schema fixture through the generated TypeScript types:
// parse the JSON into a typed value field-by-field (rejecting wrong types and
// unknown fields), then require the typed value to deep-equal the fixture.
// The Rust twin of this test is schema/tests/fixtures.rs.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  Entity,
  MutationOp,
  Status,
  type AppliedMutation,
  type Mutation,
  type MutationConflict,
  type SyncRequest,
  type SyncResponse,
  type Ticket,
  type TicketSet,
} from "../src/schema.gen";

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

function syncResponse(v: unknown): SyncResponse {
  const raw = obj(v, ["applied", "conflicts", "deltas", "latest_seq"]);
  expect(raw.applied).toBeInstanceOf(Array);
  expect(raw.conflicts).toBeInstanceOf(Array);
  expect(raw.deltas).toBeInstanceOf(Array);
  return {
    applied: (raw.applied as unknown[]).map(appliedMutation),
    conflicts: (raw.conflicts as unknown[]).map(mutationConflict),
    deltas: (raw.deltas as unknown[]).map(ticket),
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
});
