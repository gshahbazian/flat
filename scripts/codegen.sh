#!/usr/bin/env bash
# Regenerates the TypeScript wire types from the Rust schema crate.
# Requires typeshare-cli: cargo install typeshare-cli
set -euo pipefail
cd "$(dirname "$0")/.."
typeshare schema --lang typescript --output-file server/src/schema.gen.ts
