//! flat tee wire protocol.
//!
//! These Rust structs are the source of truth for the CLI <-> server
//! contract. TypeScript types are generated from them (schemars -> JSON
//! Schema -> json-schema-to-typescript); shared fixtures in `fixtures/` are
//! round-tripped by both sides in CI.
//!
//! Conventions:
//! - Every field is present on the wire (options serialize as `null`), so
//!   fixtures can be compared for exact value equality after a round trip.
//! - `seq` values fit in an f64 (JS number); the server allocates them
//!   sequentially so this holds for any realistic tenant.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Version of this wire protocol. The server rejects requests below its
/// supported minimum.
pub const PROTOCOL_VERSION: u32 = 1;

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Backlog,
    Todo,
    InProgress,
    InReview,
    Done,
    Canceled,
}

impl Default for Status {
    fn default() -> Self {
        Status::Todo
    }
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

    pub fn as_str(&self) -> &'static str {
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
            .find(|v| v.as_str() == s)
            .ok_or_else(|| format!("unknown status: {s} (expected one of: backlog, todo, in_progress, in_review, done, canceled)"))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Priority {
    None,
    Low,
    Medium,
    High,
    Urgent,
}

impl Default for Priority {
    fn default() -> Self {
        Priority::None
    }
}

impl Priority {
    pub const ALL: [Priority; 5] = [
        Priority::None,
        Priority::Low,
        Priority::Medium,
        Priority::High,
        Priority::Urgent,
    ];

    pub fn as_str(&self) -> &'static str {
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
            .find(|v| v.as_str() == s)
            .ok_or_else(|| format!("unknown priority: {s} (expected one of: none, low, medium, high, urgent)"))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Op {
    Create,
    Update,
    Delete,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum EntityKind {
    Ticket,
    Comment,
    Project,
    Member,
    Label,
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Project {
    /// Immutable ULID.
    pub id: String,
    /// Human-facing key, `^[A-Z][A-Z0-9]{1,7}$`, immutable in v1.
    pub key: String,
    /// Display name; renames freely.
    pub name: String,
    /// Optional owner emails.
    pub owners: Vec<String>,
    pub created: String,
    pub updated: String,
    /// Mutation-log seq of the last change to this entity.
    pub seq: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Ticket {
    /// Immutable ULID.
    pub id: String,
    /// Human-facing key alias, e.g. `AUTH-142`.
    pub key: String,
    pub project_id: String,
    /// Per-project counter, from 1, never reused.
    pub number: u64,
    pub title: String,
    pub status: Status,
    pub priority: Priority,
    /// Assignee email, or null.
    pub assignee: Option<String>,
    pub labels: Vec<String>,
    /// Freeform markdown body.
    pub description: String,
    pub created: String,
    pub updated: String,
    /// Mutation-log seq of the last change to this entity.
    pub seq: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Comment {
    /// Immutable ULID.
    pub id: String,
    pub ticket_id: String,
    /// Author email (the token owner, or the agent's name).
    pub author: String,
    /// When an agent token acts for a human, the human's email.
    pub on_behalf_of: Option<String>,
    pub body: String,
    pub created: String,
    pub seq: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Member {
    /// Immutable ULID.
    pub id: String,
    pub email: String,
    pub name: Option<String>,
    pub created: String,
    pub seq: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Label {
    /// Immutable ULID.
    pub id: String,
    pub name: String,
    pub created: String,
    pub seq: u64,
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/// One client write. Atomic per entity: if any field conflicts, nothing in
/// this mutation applies (other mutations in the same push still can).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Mutation {
    /// Client-generated ULID; the server's idempotency key. Replaying a
    /// mutation_id returns the original result instead of double-applying.
    pub mutation_id: String,
    pub op: Op,
    pub entity: EntityKind,
    /// Entity ULID. For `create`, the client generates it.
    pub entity_id: String,
    /// The seq the client last saw for this entity. Conflict = a field the
    /// server changed since then.
    pub base_seq: u64,
    /// Scalar fields: last-value set.
    #[serde(default)]
    pub set: BTreeMap<String, Value>,
    /// List fields (labels) travel as add/remove deltas so concurrent
    /// taggers don't clobber each other.
    #[serde(default)]
    pub labels_add: Vec<String>,
    #[serde(default)]
    pub labels_remove: Vec<String>,
}

// ---------------------------------------------------------------------------
// Sync endpoint
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SyncRequest {
    pub protocol_version: u32,
    /// Highest seq the client has applied locally; deltas above this come
    /// back in the response.
    pub last_seq: u64,
    #[serde(default)]
    pub mutations: Vec<Mutation>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct AppliedMutation {
    pub mutation_id: String,
    pub entity_id: String,
    /// Seq stamped on this change (unchanged entity seq for a no-op).
    pub seq: u64,
    /// For creates of keyed entities: the assigned key, e.g. `AUTH-142`.
    pub key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Conflict {
    pub mutation_id: String,
    pub entity_id: String,
    /// Fields the server changed since the mutation's base_seq that the
    /// mutation also tried to set.
    pub fields: Vec<String>,
    /// Current server state of the entity.
    pub server: Value,
}

/// A mutation the server refused for a reason other than a conflict
/// (validation error, unknown entity, read-only field, ...).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Rejected {
    pub mutation_id: String,
    pub entity_id: String,
    pub error: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Delta {
    pub seq: u64,
    pub entity: EntityKind,
    pub entity_id: String,
    /// `upsert` carries the full entity in `data`; `delete` carries null.
    pub op: DeltaOp,
    pub data: Option<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DeltaOp {
    Upsert,
    Delete,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SyncResponse {
    pub applied: Vec<AppliedMutation>,
    pub conflicts: Vec<Conflict>,
    pub rejected: Vec<Rejected>,
    pub deltas: Vec<Delta>,
    pub latest_seq: u64,
}

// ---------------------------------------------------------------------------
// Snapshot (bootstrap)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct Snapshot {
    /// The seq watermark this snapshot represents.
    pub latest_seq: u64,
    pub projects: Vec<Project>,
    pub tickets: Vec<Ticket>,
    pub comments: Vec<Comment>,
    pub members: Vec<Member>,
    pub labels: Vec<Label>,
    /// Pagination cursor; null when this page is the last.
    pub next_cursor: Option<String>,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Non-2xx responses carry this body. `error` is a stable machine-readable
/// code; the compaction clause uses `resync_required` (client's last_seq
/// predates the server's compaction floor -> take a fresh snapshot).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ErrorResponse {
    pub error: String,
    pub message: String,
}
