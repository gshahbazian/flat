//! Local cache of server state (`.flat/state.json`) plus per-ticket base
//! seqs. Base copies of ticket files live in `.flat/base/<KEY>.md`; a
//! working file is dirty iff its bytes differ from its base copy.

use std::collections::BTreeMap;

use anyhow::{bail, Context, Result};
use flat_schema::{Comment, Delta, DeltaOp, EntityKind, Label, Member, Project, Snapshot, Ticket};
use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct State {
    /// Highest mutation-log seq applied to this cache.
    pub last_seq: u64,
    pub projects: BTreeMap<String, Project>,
    pub tickets: BTreeMap<String, Ticket>,
    pub comments: BTreeMap<String, Comment>,
    pub members: BTreeMap<String, Member>,
    pub labels: BTreeMap<String, Label>,
    /// ticket id -> seq of the base copy in `.flat/base/`.
    pub bases: BTreeMap<String, u64>,
}

/// A ticket removed from the cache by a delete delta (so callers can clean
/// up its mirror file).
pub struct RemovedTicket {
    pub ticket: Ticket,
}

impl State {
    pub fn from_snapshot(snap: Snapshot) -> Self {
        let mut s = State {
            last_seq: snap.latest_seq,
            ..State::default()
        };
        s.projects = snap.projects.into_iter().map(|p| (p.id.clone(), p)).collect();
        s.tickets = snap.tickets.into_iter().map(|t| (t.id.clone(), t)).collect();
        s.comments = snap.comments.into_iter().map(|c| (c.id.clone(), c)).collect();
        s.members = snap.members.into_iter().map(|m| (m.id.clone(), m)).collect();
        s.labels = snap.labels.into_iter().map(|l| (l.id.clone(), l)).collect();
        s
    }

    /// Applies a delta; returns the removed ticket for ticket deletes.
    pub fn apply_delta(&mut self, delta: &Delta) -> Result<Option<RemovedTicket>> {
        let mut removed = None;
        match (delta.entity, delta.op) {
            (EntityKind::Ticket, DeltaOp::Upsert) => {
                let t: Ticket = decode(delta)?;
                self.tickets.insert(t.id.clone(), t);
            }
            (EntityKind::Ticket, DeltaOp::Delete) => {
                if let Some(t) = self.tickets.remove(&delta.entity_id) {
                    self.bases.remove(&t.id);
                    self.comments.retain(|_, c| c.ticket_id != t.id);
                    removed = Some(RemovedTicket { ticket: t });
                }
            }
            (EntityKind::Comment, DeltaOp::Upsert) => {
                let c: Comment = decode(delta)?;
                self.comments.insert(c.id.clone(), c);
            }
            (EntityKind::Comment, DeltaOp::Delete) => {
                self.comments.remove(&delta.entity_id);
            }
            (EntityKind::Project, DeltaOp::Upsert) => {
                let p: Project = decode(delta)?;
                self.projects.insert(p.id.clone(), p);
            }
            (EntityKind::Project, DeltaOp::Delete) => {
                self.projects.remove(&delta.entity_id);
            }
            (EntityKind::Member, DeltaOp::Upsert) => {
                let m: Member = decode(delta)?;
                self.members.insert(m.id.clone(), m);
            }
            (EntityKind::Member, DeltaOp::Delete) => {
                self.members.remove(&delta.entity_id);
            }
            (EntityKind::Label, DeltaOp::Upsert) => {
                let l: Label = decode(delta)?;
                self.labels.insert(l.id.clone(), l);
            }
            (EntityKind::Label, DeltaOp::Delete) => {
                self.labels.remove(&delta.entity_id);
            }
        }
        if delta.seq > self.last_seq {
            self.last_seq = delta.seq;
        }
        Ok(removed)
    }

    pub fn project_by_key(&self, key: &str) -> Result<&Project> {
        self.projects
            .values()
            .find(|p| p.key == key)
            .with_context(|| {
                let known: Vec<&str> = self.projects.values().map(|p| p.key.as_str()).collect();
                format!("unknown project key {key} (known: {})", known.join(", "))
            })
    }

    pub fn ticket_by_key(&self, key: &str) -> Result<&Ticket> {
        match self.tickets.values().find(|t| t.key == key) {
            Some(t) => Ok(t),
            None => bail!("unknown ticket {key} (run `flat sync`)"),
        }
    }

    /// Comments for a ticket in creation order.
    pub fn comments_for(&self, ticket_id: &str) -> Vec<&Comment> {
        let mut cs: Vec<&Comment> = self
            .comments
            .values()
            .filter(|c| c.ticket_id == ticket_id)
            .collect();
        cs.sort_by_key(|c| c.seq);
        cs
    }
}

fn decode<T: serde::de::DeserializeOwned>(delta: &Delta) -> Result<T> {
    let data = delta
        .data
        .clone()
        .with_context(|| format!("upsert delta for {} without data", delta.entity_id))?;
    serde_json::from_value(data).context("malformed delta payload")
}
