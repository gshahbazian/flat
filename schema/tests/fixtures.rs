//! Round-trips every fixture through the Rust types: parse, re-serialize,
//! and require the result to be byte-for-byte the same JSON value. Catches
//! renamed fields, wrong enum casing, and dropped fields on either side.

use flat_schema::{Mutation, SyncRequest, SyncResponse, Ticket};
use serde::{de::DeserializeOwned, Serialize};

fn roundtrip<T: Serialize + DeserializeOwned>(name: &str) {
    let path = format!("{}/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    let original: serde_json::Value = serde_json::from_str(&raw).expect("fixture is valid JSON");
    let typed: T = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("fixture {name} does not parse as {}: {e}", std::any::type_name::<T>()));
    let reserialized = serde_json::to_value(&typed).expect("reserialize");
    assert_eq!(reserialized, original, "fixture {name} did not round-trip");
}

#[test]
fn ticket() {
    roundtrip::<Ticket>("ticket");
}

#[test]
fn mutation() {
    roundtrip::<Mutation>("mutation");
}

#[test]
fn sync_request() {
    roundtrip::<SyncRequest>("sync_request");
}

#[test]
fn sync_response() {
    roundtrip::<SyncResponse>("sync_response");
}
