import { createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";
import { closingTicketKeys, verifyGithubSignature } from "../src/github";

describe("closingTicketKeys", () => {
  test.each([
    ["Fixes DEMO-1.", ["DEMO-1"]],
    ["CLOSES: AUTH-2!", ["AUTH-2"]],
    ["Fixes DEMO-1, AUTH-2, and BILL-7", ["DEMO-1", "AUTH-2", "BILL-7"]],
    ["Fixes DEMO-1,AUTH-2", ["DEMO-1", "AUTH-2"]],
    ["Fixes DEMO-1 and AUTH-2 and BILL-7", ["DEMO-1", "AUTH-2", "BILL-7"]],
    ["Fixes DEMO-1 AUTH-2", ["DEMO-1"]],
    ["DEMO-1: fix the race", []],
    ["prefixFixes DEMO-1", []],
    ["Fixes demo-1", []],
    ["Fixes DEMO-1 and the tests", ["DEMO-1"]],
    ["Fixes DEMO-1,", ["DEMO-1"]],
    ["Fixes\nDEMO-1", []],
    ["Example: `Fixes DEMO-1`", []],
    ["![Fixes DEMO-1](shot.png)", []],
    ["[Fixes DEMO-1](https://pr.example)", ["DEMO-1"]],
    ["<!-- Fixes DEMO-1 -->", []],
    ["> Fixes DEMO-1", []],
    ["    Fixes DEMO-1", []],
    ["~~~ts\nFixes DEMO-1\n~~~", []],
  ])("parses %j", (text, expected) => {
    expect(closingTicketKeys(text, null)).toEqual(expected);
  });

  test("scans title and body separately and de-duplicates in first-seen order", () => {
    expect(closingTicketKeys("Fixes DEMO-1", "Closes AUTH-2. Resolves DEMO-1"))
      .toEqual(["DEMO-1", "AUTH-2"]);
  });
});

describe("verifyGithubSignature", () => {
  test("matches GitHub's published HMAC vector", async () => {
    const body = new TextEncoder().encode("Hello, World!");
    const header = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
    expect(await verifyGithubSignature("It's a Secret to Everybody", body.buffer, header)).toBe(true);
  });

  test("accepts an exact HMAC over Unicode bytes", async () => {
    const secret = "It's a Secret to Everybody";
    const body = new TextEncoder().encode("Hello, 世界");
    const digest = createHmac("sha256", secret).update(body).digest("hex");
    expect(await verifyGithubSignature(secret, body.buffer, `sha256=${digest}`)).toBe(true);
  });

  test.each([null, "sha1=abc", "sha256=abc", `sha256=${"z".repeat(64)}`])(
    "rejects malformed signature %j",
    async (header) => {
      expect(await verifyGithubSignature("secret", new ArrayBuffer(0), header)).toBe(false);
    },
  );
});
