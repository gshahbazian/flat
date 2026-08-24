# Schema

The wire contract between the CLI and the server. The Rust types in
`src/lib.rs` are the source of truth; `../scripts/codegen.sh` (typeshare)
generates `server/src/schema.gen.ts` from them — rerun it and commit the
result whenever these types change.

Every message shape has a fixture in `fixtures/` that CI round-trips in both
languages: `tests/fixtures.rs` (Rust) and `server/test/fixtures.test.ts` (TS).
