//! Round-trips every fixture through the Rust types: parse, re-serialize,
//! and require the result to be byte-for-byte the same JSON value. Catches
//! renamed fields, wrong enum casing, and dropped fields on either side.

use flat_schema::{Mutation, Snapshot, SyncRequest, SyncResponse, Ticket};
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

#[test]
fn snapshot() {
    roundtrip::<Snapshot>("snapshot");
}

/// The title rule is implemented twice (Rust and server/src/validate.ts);
/// both sides run this same fixture so they can't drift apart silently.
#[test]
fn titles() {
    #[derive(serde::Deserialize)]
    struct Titles {
        valid: Vec<String>,
        invalid: Vec<String>,
    }
    let path = format!("{}/fixtures/titles.json", env!("CARGO_MANIFEST_DIR"));
    let titles: Titles = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    for title in &titles.valid {
        assert!(
            flat_schema::validate_title(title).is_ok(),
            "expected valid: {title:?}"
        );
    }
    for title in &titles.invalid {
        assert!(
            flat_schema::validate_title(title).is_err(),
            "expected invalid: {title:?}"
        );
    }
}
