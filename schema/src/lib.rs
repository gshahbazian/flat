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

/// Normalize the ASCII email form used for member identity.
pub fn normalize_email(email: &str) -> Result<String, String> {
    let email = email
        .trim_matches(|c| matches!(c, ' ' | '\t' | '\n' | '\r' | '\x0b' | '\x0c'))
        .to_ascii_lowercase();
    if !email.is_ascii()
        || email
            .chars()
            .any(|c| c.is_ascii_whitespace() || c.is_ascii_control())
    {
        return Err("invalid_email".into());
    }

    let mut parts = email.split('@');
    let local = parts.next().unwrap_or_default();
    let domain = parts.next().unwrap_or_default();
    if local.is_empty() || domain.is_empty() || parts.next().is_some() {
        return Err("invalid_email".into());
    }
    let labels: Vec<&str> = domain.split('.').collect();
    if labels.len() < 2 || labels.iter().any(|label| label.is_empty()) {
        return Err("invalid_email".into());
    }
    Ok(email)
}

#[typeshare]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Admin,
    Member,
    Viewer,
}

#[typeshare]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemberStatus {
    Pending,
    Active,
    Suspended,
}

#[typeshare]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TokenKind {
    Human,
    Agent,
}

#[typeshare]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TokenAccess {
    Read,
    Write,
    Admin,
}

/// The non-sensitive member profile included in normal sync data.
#[typeshare]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemberProfile {
    pub id: String,
    pub email: String,
    pub role: Role,
    pub status: MemberStatus,
    pub created_at: String,
    #[typeshare(serialized_as = "NullableString")]
    pub activated_at: Option<String>,
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
                format!(
                    "unknown status {s:?} (expected one of: {})",
                    expected.join(", ")
                )
            })
    }
}

/// Ticket priority, ordered here only for stable parsing and documentation.
#[typeshare]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Priority {
    None,
    Low,
    Medium,
    High,
    Urgent,
}

impl Priority {
    pub const ALL: [Priority; 5] = [
        Priority::None,
        Priority::Low,
        Priority::Medium,
        Priority::High,
        Priority::Urgent,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Priority::None => "none",
            Priority::Low => "low",
            Priority::Medium => "medium",
            Priority::High => "high",
            Priority::Urgent => "urgent",
        }
    }
}

impl std::str::FromStr for Priority {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Priority::ALL
            .into_iter()
            .find(|priority| priority.as_str() == s)
            .ok_or_else(|| {
                let expected: Vec<&str> = Priority::ALL.iter().map(|p| p.as_str()).collect();
                format!(
                    "unknown priority {s:?} (expected one of: {})",
                    expected.join(", ")
                )
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
    pub priority: Priority,
    /// Assigned member ULID, or null when unassigned.
    #[typeshare(serialized_as = "NullableString")]
    pub assignee: Option<String>,
    /// Server-generated UTC timestamps. Clients may not set these fields.
    pub created_at: String,
    pub updated_at: String,
    /// Seq of the last mutation applied to this ticket.
    pub seq: u32,
}

/// A server deletion that removes the corresponding local mirror state.
#[typeshare]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TicketTombstone {
    pub id: String,
    pub key: String,
    /// Seq assigned to the delete mutation.
    pub seq: u32,
}

#[typeshare]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MutationOp {
    Create,
    Update,
    Delete,
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
    pub priority: Option<Priority>,
    /// Outer `None` omits the field; `Some(None)` explicitly clears it.
    #[serde(
        default,
        deserialize_with = "deserialize_optional_nullable_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub assignee: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

fn deserialize_optional_nullable_string<'de, D>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(Some)
}

/// One atomic change to one entity. All edits to a ticket travel in a single
/// mutation; if any part is rejected, none of it applies.
#[typeshare]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Mutation {
    /// Opaque unique idempotency key. CLI-generated values are ULIDs, while
    /// trusted integrations may use a namespaced string. The server never
    /// parses or orders mutations by this value.
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

/// Canonical JSON used when binding an idempotency key to a mutation. Object
/// keys are lexicographically ordered at every level and absent optional
/// fields stay omitted. Transport metadata is not part of this value.
pub fn canonical_mutation_json(mutation: &Mutation) -> Result<String, serde_json::Error> {
    fn sorted(value: serde_json::Value) -> serde_json::Value {
        match value {
            serde_json::Value::Array(values) => {
                serde_json::Value::Array(values.into_iter().map(sorted).collect())
            }
            serde_json::Value::Object(values) => {
                let mut entries: Vec<_> = values.into_iter().collect();
                entries.sort_by(|left, right| left.0.cmp(&right.0));
                serde_json::Value::Object(
                    entries
                        .into_iter()
                        .map(|(key, value)| (key, sorted(value)))
                        .collect(),
                )
            }
            value => value,
        }
    }

    serde_json::to_string(&sorted(serde_json::to_value(mutation)?))
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
    /// Tickets deleted since `last_seq`.
    #[serde(default)]
    pub tombstones: Vec<TicketTombstone>,
    /// Current safe profiles. Administrative sequence gaps may occur without
    /// exposing their private records.
    #[serde(default)]
    pub members: Vec<MemberProfile>,
    pub latest_seq: u32,
}

/// Bootstrap payload from `GET /snapshot`.
#[typeshare]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snapshot {
    pub tickets: Vec<Ticket>,
    #[serde(default)]
    pub members: Vec<MemberProfile>,
    /// The seq watermark this snapshot represents.
    pub latest_seq: u32,
}

/// Token names are portable ASCII identifiers used in CLI and audit output.
pub fn validate_token_name(name: &str) -> Result<(), String> {
    let bytes = name.as_bytes();
    if bytes.is_empty() || bytes.len() > 64 || !bytes[0].is_ascii_alphanumeric() {
        return Err("invalid_token_name".into());
    }
    if bytes[1..]
        .iter()
        .any(|byte| !byte.is_ascii_alphanumeric() && !matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err("invalid_token_name".into());
    }
    Ok(())
}
