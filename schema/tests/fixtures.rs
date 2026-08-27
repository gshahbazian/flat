//! Round-trips every fixture through the Rust types: parse, re-serialize,
//! and require the result to be byte-for-byte the same JSON value. Catches
//! renamed fields, wrong enum casing, and dropped fields on either side.

use flat_schema::{
    Comment, Mutation, Project, SearchErrorDetail, SearchRequest, SearchResponse, Snapshot,
    SyncRequest, SyncResponse, Ticket, TicketSet,
};
use serde::{de::DeserializeOwned, Serialize};

fn roundtrip<T: Serialize + DeserializeOwned>(name: &str) {
    let path = format!("{}/fixtures/{name}.json", env!("CARGO_MANIFEST_DIR"));
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    let original: serde_json::Value = serde_json::from_str(&raw).expect("fixture is valid JSON");
    let typed: T = serde_json::from_str(&raw).unwrap_or_else(|e| {
        panic!(
            "fixture {name} does not parse as {}: {e}",
            std::any::type_name::<T>()
        )
    });
    let reserialized = serde_json::to_value(&typed).expect("reserialize");
    assert_eq!(reserialized, original, "fixture {name} did not round-trip");
}

#[test]
fn ticket() {
    roundtrip::<Ticket>("ticket");
}

#[test]
fn comment() {
    roundtrip::<Comment>("comment");
}

#[test]
fn project() {
    roundtrip::<Project>("project");
}

#[test]
fn mutation() {
    roundtrip::<Mutation>("mutation");
}

#[test]
fn project_mutation() {
    roundtrip::<Mutation>("project_mutation");
}

#[test]
fn comment_mutation() {
    roundtrip::<Mutation>("comment_mutation");
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

#[test]
fn search_request() {
    roundtrip::<SearchRequest>("search_request");
}

#[test]
fn search_response() {
    roundtrip::<SearchResponse>("search_response");
}

#[test]
fn search_error_detail() {
    roundtrip::<SearchErrorDetail>("search_error_detail");
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

#[test]
fn emails() {
    #[derive(serde::Deserialize)]
    struct ValidEmail {
        input: String,
        normalized: String,
    }
    #[derive(serde::Deserialize)]
    struct Emails {
        valid: Vec<ValidEmail>,
        invalid: Vec<String>,
    }
    let path = format!("{}/fixtures/emails.json", env!("CARGO_MANIFEST_DIR"));
    let emails: Emails = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    for email in &emails.valid {
        assert_eq!(
            flat_schema::normalize_email(&email.input).unwrap(),
            email.normalized
        );
    }
    for email in &emails.invalid {
        assert!(
            flat_schema::normalize_email(email).is_err(),
            "expected invalid: {email:?}"
        );
    }
}

#[test]
fn mutation_canonical_json() {
    #[derive(serde::Deserialize)]
    struct CanonicalMutation {
        mutation: Mutation,
        canonical_json: String,
    }
    let path = format!(
        "{}/fixtures/canonical_mutation.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let fixture: CanonicalMutation =
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert_eq!(
        flat_schema::canonical_mutation_json(&fixture.mutation).unwrap(),
        fixture.canonical_json,
    );
}

#[test]
fn assignment_set_preserves_omit_assign_and_clear() {
    let omitted = serde_json::to_value(TicketSet::default()).unwrap();
    assert_eq!(omitted, serde_json::json!({}));

    let assigned = TicketSet {
        assignee: Some(Some("member-1".into())),
        ..TicketSet::default()
    };
    assert_eq!(
        serde_json::to_value(assigned).unwrap(),
        serde_json::json!({ "assignee": "member-1" })
    );

    let cleared = TicketSet {
        assignee: Some(None),
        ..TicketSet::default()
    };
    assert_eq!(
        serde_json::to_value(cleared).unwrap(),
        serde_json::json!({ "assignee": null })
    );
    assert_eq!(
        serde_json::from_value::<TicketSet>(serde_json::json!({ "assignee": null }))
            .unwrap()
            .assignee,
        Some(None)
    );
}

#[test]
fn priorities_parse_by_wire_name() {
    for priority in flat_schema::Priority::ALL {
        assert_eq!(priority.as_str().parse(), Ok(priority));
    }
    assert!("critical".parse::<flat_schema::Priority>().is_err());
}

#[test]
fn token_names() {
    for name in ["gabe-macbook", "ci_1", "flat.cli"] {
        assert!(flat_schema::validate_token_name(name).is_ok(), "{name:?}");
    }
    for name in ["", "bad name", "-leading", &"a".repeat(65)] {
        assert!(flat_schema::validate_token_name(name).is_err(), "{name:?}");
    }
}

#[test]
fn comment_bodies() {
    assert!(flat_schema::validate_comment_body("Markdown\n\n- works").is_ok());
    assert!(flat_schema::validate_comment_body(" \n\t").is_err());
    assert!(flat_schema::validate_comment_body("\u{0085}").is_err());
    assert!(flat_schema::validate_comment_body("\u{feff}").is_ok());
    assert!(
        flat_schema::validate_comment_body(&"a".repeat(flat_schema::MAX_COMMENT_BYTES)).is_ok()
    );
    assert!(
        flat_schema::validate_comment_body(&"a".repeat(flat_schema::MAX_COMMENT_BYTES + 1))
            .is_err()
    );
    assert!(
        flat_schema::validate_comment_body(&"é".repeat(flat_schema::MAX_COMMENT_BYTES / 2)).is_ok()
    );
    assert!(flat_schema::validate_comment_body(
        &"é".repeat(flat_schema::MAX_COMMENT_BYTES / 2 + 1)
    )
    .is_err());
}

#[test]
fn ticket_bodies_reserve_the_comment_sentinel() {
    assert!(flat_schema::validate_ticket_body("ordinary <!-- flat:comments --> text").is_ok());
    assert!(flat_schema::validate_ticket_body("before\n<!-- flat:comments -->\nafter").is_err());
    assert!(
        flat_schema::validate_ticket_body("before\r\n<!-- flat:comments -->\r\nafter").is_err()
    );
}

#[test]
fn project_keys_and_names() {
    for key in ["DE", "AUTH", "A1", "PROJECT8"] {
        assert!(flat_schema::validate_project_key(key).is_ok(), "{key:?}");
    }
    for key in ["", "A", "demo", "DE-MO", "PROJECT99"] {
        assert!(flat_schema::validate_project_key(key).is_err(), "{key:?}");
    }

    assert!(flat_schema::validate_project_name(" Authentication ").is_ok());
    assert!(flat_schema::validate_project_name("").is_err());
    assert!(flat_schema::validate_project_name("bad\nname").is_err());
    assert!(flat_schema::validate_project_name(&"a".repeat(81)).is_err());
}
