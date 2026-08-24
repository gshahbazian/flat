// Contract tests: the shared fixtures in /schema/fixtures must validate
// against the JSON Schemas generated from the Rust types. The Rust side
// round-trips the same fixtures (schema/tests/fixtures.rs), so neither
// language can drift from the wire contract unnoticed.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import { describe, expect, test } from "vitest";

const schemaDir = join(__dirname, "..", "..", "schema", "json");
const fixtureDir = join(__dirname, "..", "..", "schema", "fixtures");

const ajv = new Ajv({ strict: false, validateFormats: false });

function load(dir: string, name: string): unknown {
  return JSON.parse(readFileSync(join(dir, name), "utf8"));
}

const cases: Array<[schema: string, fixture: string]> = [
  ["Project", "project.json"],
  ["Ticket", "ticket.json"],
  ["Comment", "comment.json"],
  ["Member", "member.json"],
  ["Label", "label.json"],
  ["Mutation", "mutation_create_ticket.json"],
  ["Mutation", "mutation_update_ticket.json"],
  ["SyncRequest", "sync_request.json"],
  ["SyncResponse", "sync_response.json"],
  ["Snapshot", "snapshot.json"],
  ["ErrorResponse", "error_resync.json"],
];

describe("fixtures validate against generated schemas", () => {
  for (const [schemaName, fixture] of cases) {
    test(`${fixture} is a valid ${schemaName}`, () => {
      const validate = ajv.compile(load(schemaDir, `${schemaName}.schema.json`) as object);
      const valid = validate(load(fixtureDir, fixture));
      expect(validate.errors ?? []).toEqual([]);
      expect(valid).toBe(true);
    });
  }
});

describe("schemas reject bad data", () => {
  test("unknown status enum value", () => {
    const validate = ajv.compile(load(schemaDir, "Ticket.schema.json") as object);
    const ticket = load(fixtureDir, "ticket.json") as Record<string, unknown>;
    ticket.status = "blocked";
    expect(validate(ticket)).toBe(false);
  });

  test("missing required field", () => {
    const validate = ajv.compile(load(schemaDir, "Mutation.schema.json") as object);
    const mutation = load(fixtureDir, "mutation_update_ticket.json") as Record<string, unknown>;
    delete mutation.base_seq;
    expect(validate(mutation)).toBe(false);
  });
});
