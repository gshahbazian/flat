//! Round-trips every shared fixture through the Rust types. The server
//! validates the same fixtures against the generated JSON Schemas, so the
//! two sides can't silently drift apart.

use std::fs;
use std::path::Path;

use flat_schema::*;
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;

fn roundtrip<T: Serialize + DeserializeOwned>(fixture: &str) {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures")
        .join(fixture);
    let text = fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {fixture}: {e}"));
    let raw: Value = serde_json::from_str(&text).unwrap_or_else(|e| panic!("parse {fixture}: {e}"));
    let typed: T =
        serde_json::from_value(raw.clone()).unwrap_or_else(|e| panic!("decode {fixture}: {e}"));
    let back = serde_json::to_value(&typed).unwrap();
    assert_eq!(back, raw, "round trip changed {fixture}");
}

#[test]
fn entities() {
    roundtrip::<Project>("project.json");
    roundtrip::<Ticket>("ticket.json");
    roundtrip::<Comment>("comment.json");
    roundtrip::<Member>("member.json");
    roundtrip::<Label>("label.json");
}

#[test]
fn mutations() {
    roundtrip::<Mutation>("mutation_create_ticket.json");
    roundtrip::<Mutation>("mutation_update_ticket.json");
}

#[test]
fn sync_messages() {
    roundtrip::<SyncRequest>("sync_request.json");
    roundtrip::<SyncResponse>("sync_response.json");
    roundtrip::<Snapshot>("snapshot.json");
    roundtrip::<ErrorResponse>("error_resync.json");
}

#[test]
fn unknown_enum_values_are_rejected() {
    assert!(serde_json::from_str::<Status>("\"blocked\"").is_err());
    assert!(serde_json::from_str::<Priority>("\"p0\"").is_err());
}
