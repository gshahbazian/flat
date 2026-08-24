//! Wire contract between the `flat` CLI and the server.
//!
//! Rust is the source of truth. `server/src/schema.gen.ts` is generated from
//! these types with typeshare — run `scripts/codegen.sh` after editing and
//! commit the result. Every message shape has a fixture in `fixtures/` that is
//! round-tripped in CI by both languages (see `tests/fixtures.rs` and
//! `server/test/fixtures.test.ts`).

use serde::{Deserialize, Serialize};
use typeshare::typeshare;

pub const PROTOCOL_VERSION: u32 = 1;

/// The one rule for ticket titles, enforced by both the CLI and the server
/// (mirrored in `server/src/validate.ts`): non-empty, single line, no control
/// characters. A newline in a title would corrupt the markdown frontmatter,
/// and that format is harder to change than the wire protocol.
/// `fixtures/titles.json` runs against both implementations in CI.
///
/// Titles are stored trimmed everywhere; callers trim before validating so
/// title equality never hinges on invisible whitespace.
pub fn validate_title(title: &str) -> Result<(), String> {
    if title.trim().is_empty() {
        return Err("title must not be empty".into());
    }
    if title.chars().any(|c| c.is_control()) {
        return Err("title must be a single line without control characters".into());
    }
    Ok(())
}

/// Ticket workflow state.
#[typeshare]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Backlog,
    Todo,
    InProgress,
    InReview,
    Done,
    Canceled,
}

impl Status {
    pub const ALL: [Status; 6] = [
        Status::Backlog,
        Status::Todo,
        Status::InProgress,
        Status::InReview,
        Status::Done,
        Status::Canceled,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Status::Backlog => "backlog",
            Status::Todo => "todo",
            Status::InProgress => "in_progress",
            Status::InReview => "in_review",
            Status::Done => "done",
            Status::Canceled => "canceled",
        }
    }
}

impl std::str::FromStr for Status {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Status::ALL
            .into_iter()
            .find(|status| status.as_str() == s)
            .ok_or_else(|| {
                let expected: Vec<&str> = Status::ALL.iter().map(|s| s.as_str()).collect();
                format!("unknown status {s:?} (expected one of: {})", expected.join(", "))
            })
    }
}

/// A ticket as stored by the server and mirrored to markdown.
#[typeshare]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ticket {
    /// Immutable ULID; the protocol speaks ULIDs.
    pub id: String,
    /// Human-facing key alias, e.g. `DEMO-1`. Assigned by the server.
    pub key: String,
    pub title: String,
    pub body: String,
    pub status: Status,
    /// Seq of the last mutation applied to this ticket.
    pub seq: u32,
}

#[typeshare]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MutationOp {
    Create,
    Update,
}

#[typeshare]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Entity {
    Ticket,
}

/// Scalar fields a mutation may set. Absent fields are left untouched.
#[typeshare]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TicketSet {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<Status>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

/// One atomic change to one entity. All edits to a ticket travel in a single
/// mutation; if any part is rejected, none of it applies.
#[typeshare]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Mutation {
    /// Client-generated ULID; the idempotency key. Replaying a mutation_id
    /// returns the original result instead of double-applying.
    pub mutation_id: String,
    pub op: MutationOp,
    pub entity: Entity,
    /// Client-generated ULID of the ticket (also on create).
    pub entity_id: String,
    /// Seq the client last saw for this entity. Required on update; absent on
    /// create. A stale base_seq is not by itself a conflict: the mutation
    /// still applies if it only touches fields the server has not changed
    /// since. A field both sides changed rejects the whole mutation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_seq: Option<u32>,
    pub set: TicketSet,
}

#[typeshare]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncRequest {
    pub protocol_version: u32,
    /// Highest seq the client has applied locally; deltas come back from here.
    pub last_seq: u32,
    pub mutations: Vec<Mutation>,
}

/// Outcome of one applied mutation.
#[typeshare]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AppliedMutation {
    pub mutation_id: String,
    pub entity_id: String,
    /// Ticket key — tells the client the server-assigned key on create.
    pub key: String,
    pub seq: u32,
}

/// A rejected mutation. Nothing from it was applied.
#[typeshare]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MutationConflict {
    pub mutation_id: String,
    pub entity_id: String,
    pub reason: String,
}

#[typeshare]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncResponse {
    pub applied: Vec<AppliedMutation>,
    pub conflicts: Vec<MutationConflict>,
    /// Full rows for every ticket changed since the request's `last_seq`.
    pub deltas: Vec<Ticket>,
    pub latest_seq: u32,
}

/// Bootstrap payload from `GET /snapshot`.
#[typeshare]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snapshot {
    pub tickets: Vec<Ticket>,
    /// The seq watermark this snapshot represents.
    pub latest_seq: u32,
}
