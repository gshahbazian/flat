// Field-level conflict detection: an update against a stale base_seq is
// rejected only where it sets a field the server also changed since.
import { describe, expect, test } from "vitest";

import { conflictingFields, fieldsSet } from "../src/conflict";
import { Status, type TicketSet } from "../src/schema.gen";

describe("fieldsSet", () => {
  test("lists only the fields present", () => {
    expect(fieldsSet({ title: "x" })).toEqual(["title"]);
    expect(fieldsSet({ status: Status.Done, body: "b" })).toEqual(["status", "body"]);
    expect(fieldsSet({})).toEqual([]);
  });

  test("tolerates missing or null sets from old log entries", () => {
    expect(fieldsSet(null)).toEqual([]);
    expect(fieldsSet(undefined)).toEqual([]);
    expect(fieldsSet({ title: null } as unknown as TicketSet)).toEqual([]);
  });
});

describe("conflictingFields", () => {
  test("disjoint edits do not conflict", () => {
    expect(conflictingFields({ title: "mine" }, [{ status: Status.Done }, { body: "b" }])).toEqual(
      [],
    );
  });

  test("a field both sides set conflicts", () => {
    expect(conflictingFields({ title: "mine", body: "b" }, [{ title: "theirs" }])).toEqual([
      "title",
    ]);
  });

  test("server changes accumulate across log entries", () => {
    expect(
      conflictingFields({ title: "t", status: Status.Todo, body: "b" }, [
        { title: "a" },
        { body: "c" },
      ]),
    ).toEqual(["title", "body"]);
  });

  test("no server changes means no conflict", () => {
    expect(conflictingFields({ title: "t" }, [])).toEqual([]);
  });
});
