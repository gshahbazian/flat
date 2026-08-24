//! Emits JSON Schemas for the wire protocol into `schema/json/`.
//!
//! - one `<type>.schema.json` per top-level message (ajv contract tests)
//! - `protocol.schema.json` combining everything (input to
//!   json-schema-to-typescript, see `server/package.json` `codegen`)
//!
//! Run via `cargo run -p flat-schema --bin codegen` (any cwd).

use std::fs;
use std::path::Path;

use flat_schema::*;
use schemars::schema_for;
use serde_json::{json, Map, Value};

fn root_to_value<T: schemars::JsonSchema>() -> Value {
    serde_json::to_value(schema_for!(T)).expect("schema serializes")
}

fn main() {
    let out_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("json");
    fs::create_dir_all(&out_dir).expect("create schema/json");

    let types: Vec<(&str, Value)> = vec![
        ("Project", root_to_value::<Project>()),
        ("Ticket", root_to_value::<Ticket>()),
        ("Comment", root_to_value::<Comment>()),
        ("Member", root_to_value::<Member>()),
        ("Label", root_to_value::<Label>()),
        ("Mutation", root_to_value::<Mutation>()),
        ("SyncRequest", root_to_value::<SyncRequest>()),
        ("SyncResponse", root_to_value::<SyncResponse>()),
        ("Snapshot", root_to_value::<Snapshot>()),
        ("ErrorResponse", root_to_value::<ErrorResponse>()),
    ];

    // Per-type schemas, used by the server's fixture contract tests.
    for (name, schema) in &types {
        let path = out_dir.join(format!("{name}.schema.json"));
        fs::write(&path, pretty(schema)).expect("write schema");
        println!("wrote {}", path.display());
    }

    // Combined schema: every type under definitions, referenced from a
    // synthetic root so json-schema-to-typescript emits them all in one file.
    let mut definitions = Map::new();
    let mut properties = Map::new();
    for (name, schema) in &types {
        let mut obj = schema.as_object().expect("schema object").clone();
        obj.remove("$schema");
        if let Some(Value::Object(defs)) = obj.remove("definitions") {
            for (k, v) in defs {
                definitions.insert(k, v);
            }
        }
        definitions.insert(name.to_string(), Value::Object(obj));
        properties.insert(
            to_snake(name),
            json!({ "$ref": format!("#/definitions/{name}") }),
        );
    }
    let combined = json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "title": "FlatProtocol",
        "description": "Generated from Rust (schema/src/lib.rs). Do not edit.",
        "type": "object",
        "properties": properties,
        "required": properties_keys(&properties),
        "additionalProperties": false,
        "definitions": definitions,
    });
    let path = out_dir.join("protocol.schema.json");
    fs::write(&path, pretty(&combined)).expect("write protocol schema");
    println!("wrote {}", path.display());
}

fn properties_keys(properties: &Map<String, Value>) -> Vec<String> {
    properties.keys().cloned().collect()
}

fn to_snake(name: &str) -> String {
    let mut out = String::new();
    for (i, c) in name.chars().enumerate() {
        if c.is_uppercase() {
            if i > 0 {
                out.push('_');
            }
            out.extend(c.to_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

fn pretty(v: &Value) -> String {
    let mut s = serde_json::to_string_pretty(v).expect("pretty json");
    s.push('\n');
    s
}
