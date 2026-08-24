//! `flat` — tickets as markdown files.
//!
//! Tracer-bullet surface: init, new, sync, push, path.

mod api;
mod markdown;
mod merge;
mod store;

use std::collections::HashSet;
use std::fs;

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use flat_schema::{
    Entity, Mutation, MutationOp, SyncRequest, SyncResponse, Ticket, TicketSet, PROTOCOL_VERSION,
};
use ulid::Ulid;

use api::Client;
use store::{Checkout, Config};

#[derive(Parser)]
#[command(name = "flat", version, about = "tickets as markdown files")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Connect to a server and take a first snapshot.
    Init {
        /// Server URL, e.g. http://localhost:8787
        #[arg(long)]
        server: String,
        /// Bearer token for the server.
        #[arg(long)]
        token: String,
    },
    /// Create a ticket on the server and materialize its file.
    New { title: String },
    /// Pull server changes into the mirror.
    Sync {
        /// Three-way merge server changes into files with local edits,
        /// writing git-style conflict markers where both sides changed the
        /// same thing.
        #[arg(long)]
        merge: bool,
    },
    /// Push locally edited ticket files to the server.
    Push,
    /// Print the mirror location.
    Path,
}

fn main() {
    if let Err(e) = run() {
        eprintln!("error: {e:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let root = store::flat_root()?;
    match Cli::parse().command {
        Command::Init { server, token } => {
            // Talk to the server before touching anything on disk, so a bad
            // URL or token can't brick an existing checkout.
            let snapshot = Client::new(&server, &token).snapshot()?;
            store::save_config(&root, &Config { server, token })?;
            let mut checkout = Checkout::open(&root)?;
            // The snapshot is authoritative: reconcile, don't layer. After
            // reset() nothing is dirty, so no delta can be skipped.
            checkout.reset()?;
            checkout.apply_deltas(&snapshot.tickets, &HashSet::new(), &HashSet::new())?;
            checkout.state.last_seq = snapshot.latest_seq;
            checkout.save_state()?;
            println!(
                "initialized {} ({} tickets, seq {})",
                checkout.mirror_dir().display(),
                snapshot.tickets.len(),
                snapshot.latest_seq
            );
        }
        Command::New { title } => {
            let title = title.trim().to_string();
            flat_schema::validate_title(&title).map_err(anyhow::Error::msg)?;
            let mut checkout = Checkout::open(&root)?;
            if !checkout.pending_mutations()?.is_empty() {
                bail!("a previous mutation may not have reached the server; run `flat sync` to replay it first");
            }
            // Journal the create before sending: if the response is lost, the
            // next `flat sync` replays the same mutation_id instead of a rerun
            // minting fresh IDs and creating a duplicate ticket.
            let mutation = Mutation {
                mutation_id: Ulid::new().to_string(),
                op: MutationOp::Create,
                entity: Entity::Ticket,
                entity_id: Ulid::new().to_string(),
                base_seq: None,
                set: TicketSet { title: Some(title), status: None, body: None },
            };
            let mutation_id = mutation.mutation_id.clone();
            checkout.write_pending(&mutation)?;
            let response = send(&mut checkout, vec![])?;
            if let Some(conflict) = response.conflicts.iter().find(|c| c.mutation_id == mutation_id) {
                bail!("create rejected: {}", conflict.reason);
            }
            let created = response
                .applied
                .iter()
                .find(|a| a.mutation_id == mutation_id)
                .context("server returned no result")?
                .clone();
            let skipped = checkout.apply_deltas(&response.deltas, &HashSet::new(), &HashSet::new())?;
            report_kept(&checkout, &skipped);
            if skipped.is_empty() {
                checkout.state.last_seq = response.latest_seq;
            }
            checkout.save_state()?;
            println!("{}  {}", created.key, checkout.mirror_path(&created.key).display());
        }
        Command::Sync { merge } => {
            let mut checkout = Checkout::open(&root)?;
            let response = send(&mut checkout, vec![])?;
            // Anything applied here was a replayed pending mutation.
            for applied in &response.applied {
                println!("recovered pending {} (seq {})", applied.key, applied.seq);
            }
            for conflict in &response.conflicts {
                eprintln!("pending mutation rejected: {}", conflict.reason);
            }
            let skipped = checkout.apply_deltas(&response.deltas, &HashSet::new(), &HashSet::new())?;
            let unresolved = if merge {
                merge_skipped(&mut checkout, &skipped)?
            } else {
                report_kept(&checkout, &skipped);
                skipped.len()
            };
            for key in checkout.restore_missing()? {
                println!("restored {} (was deleted locally)", checkout.mirror_path(&key).display());
            }
            // Withheld deltas must come back on the next sync: last_seq only
            // advances once every delta has landed in the mirror.
            if unresolved == 0 {
                checkout.state.last_seq = response.latest_seq;
            }
            checkout.save_state()?;
            if unresolved > 0 {
                if merge {
                    bail!("{unresolved} file(s) could not be merged; fix them and rerun `flat sync --merge`");
                }
                bail!("{unresolved} file(s) have local edits the server also changed; run `flat sync --merge`");
            }
            println!("synced {} tickets (seq {})", response.deltas.len(), response.latest_seq);
        }
        Command::Push => {
            push(&mut Checkout::open(&root)?)?;
        }
        Command::Path => {
            println!("{}", Checkout::open(&root)?.host_dir().display());
        }
    }
    Ok(())
}

fn client(checkout: &Checkout) -> Client {
    Client::new(&checkout.config.server, &checkout.config.token)
}

/// Sends mutations, with any journaled pending mutations replayed first
/// (idempotent server-side). Acknowledged pending entries are cleared.
fn send(checkout: &mut Checkout, mutations: Vec<Mutation>) -> Result<SyncResponse> {
    let mut all = checkout.pending_mutations()?;
    all.extend(mutations);
    let response = client(checkout).sync(&SyncRequest {
        protocol_version: PROTOCOL_VERSION,
        last_seq: checkout.state.last_seq,
        mutations: all,
    })?;
    for mutation_id in response
        .applied
        .iter()
        .map(|a| &a.mutation_id)
        .chain(response.conflicts.iter().map(|c| &c.mutation_id))
    {
        checkout.clear_pending(mutation_id)?;
    }
    Ok(response)
}

/// Diffs every mirror file against its base copy and pushes one update
/// mutation per dirty ticket.
fn push(checkout: &mut Checkout) -> Result<()> {
    let mirror_dir = checkout.mirror_dir();
    let mut mutations = Vec::new();
    let mut pushed_keys = HashSet::new();

    let mut entries: Vec<_> = match fs::read_dir(&mirror_dir) {
        Ok(entries) => entries.collect::<std::io::Result<_>>()?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(e).context(format!("reading {}", mirror_dir.display())),
    };
    entries.sort_by_key(|e| e.file_name());

    for entry in entries {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let stem = path.file_stem().unwrap().to_string_lossy().to_string();
        let ticket_state = match checkout.state.tickets.get(&stem) {
            Some(s) => s.clone(),
            None => {
                eprintln!("warning: {} is not a synced ticket (use `flat new`); skipped", path.display());
                continue;
            }
        };

        let content = fs::read_to_string(&path)?;
        // Frontmatter markers already fail the parse below; this catches
        // markers in the freeform body, which would otherwise push silently.
        if content.lines().any(|l| l.starts_with("<<<<<<<") || l.starts_with(">>>>>>>")) {
            bail!("{} has unresolved conflict markers; edit them away and push again", path.display());
        }
        let file = markdown::parse(&content).with_context(|| format!("parsing {}", path.display()))?;
        if file.key != stem {
            bail!("{}: id is read-only (file says {:?}, expected {:?})", path.display(), file.key, stem);
        }
        let base_content = fs::read_to_string(checkout.base_path(&stem))
            .with_context(|| format!("no base copy for {stem} — run `flat sync`"))?;
        let base = markdown::parse(&base_content).with_context(|| format!("parsing base copy of {stem}"))?;

        // One mutation carries every changed field: atomic per ticket.
        let set = TicketSet {
            title: (file.title != base.title).then(|| file.title.clone()),
            status: (file.status != base.status).then_some(file.status),
            body: (file.body != base.body).then(|| file.body.clone()),
        };
        if set == TicketSet::default() {
            continue;
        }
        pushed_keys.insert(stem.clone());
        mutations.push(Mutation {
            mutation_id: Ulid::new().to_string(),
            op: MutationOp::Update,
            entity: Entity::Ticket,
            entity_id: ticket_state.id.clone(),
            base_seq: Some(ticket_state.seq),
            set,
        });
    }

    if mutations.is_empty() {
        println!("nothing to push");
        return Ok(());
    }

    let response = send(checkout, mutations)?;

    let key_of = |entity_id: &str| {
        checkout
            .state
            .tickets
            .iter()
            .find(|(_, s)| s.id == entity_id)
            .map(|(key, _)| key.clone())
            .unwrap_or_else(|| entity_id.to_string())
    };
    for applied in &response.applied {
        println!("pushed {} (seq {})", applied.key, applied.seq);
    }
    let conflicted: HashSet<String> = response.conflicts.iter().map(|c| key_of(&c.entity_id)).collect();
    for conflict in &response.conflicts {
        eprintln!("rejected {}: {}", key_of(&conflict.entity_id), conflict.reason);
    }

    // Conflicted files keep their local edits. Tickets we just pushed may
    // clobber their own files: those local edits are now server state (the
    // delta row folds them together with whatever disjoint fields the server
    // changed). last_seq only advances on a clean push so a later sync
    // re-delivers anything skipped here.
    let applied_keys: HashSet<String> = response.applied.iter().map(|a| a.key.clone()).collect();
    let skipped = checkout.apply_deltas(&response.deltas, &conflicted, &applied_keys)?;
    report_kept(checkout, &skipped);
    if conflicted.is_empty() && skipped.is_empty() {
        checkout.state.last_seq = response.latest_seq;
    }
    checkout.save_state()?;

    if !conflicted.is_empty() {
        bail!(
            "{} ticket(s) rejected; run `flat sync --merge` to merge the server's changes, then push again",
            conflicted.len()
        );
    }
    Ok(())
}

/// Reports deltas that were withheld because the mirror file has local edits.
fn report_kept(checkout: &Checkout, skipped: &[Ticket]) {
    for ticket in skipped {
        eprintln!(
            "kept local edits in {} (server changed it too; run `flat sync --merge`)",
            checkout.mirror_path(&ticket.key).display()
        );
    }
}

/// Three-way merges each withheld delta into its dirty mirror file. Returns
/// how many were left untouched (unparseable local files).
fn merge_skipped(checkout: &mut Checkout, skipped: &[Ticket]) -> Result<usize> {
    let mut unresolved = 0;
    for ticket in skipped {
        let mirror = checkout.mirror_path(&ticket.key);
        let local_raw = fs::read_to_string(&mirror)?;
        let local = match markdown::parse(&local_raw) {
            Ok(local) => local,
            Err(e) => {
                eprintln!(
                    "cannot merge {}: {e:#} (fix the file, or delete it to discard local edits)",
                    mirror.display()
                );
                unresolved += 1;
                continue;
            }
        };
        let base_raw = fs::read_to_string(checkout.base_path(&ticket.key))
            .with_context(|| format!("no base copy for {} — run `flat init`", ticket.key))?;
        let base = markdown::parse(&base_raw)
            .with_context(|| format!("parsing base copy of {}", ticket.key))?;
        let merged = merge::merge(&base, &local, ticket);
        checkout.write_merged(ticket, &merged.content)?;
        if merged.conflicted {
            eprintln!("conflicts in {} — edit the markers away, then `flat push`", mirror.display());
        } else {
            println!("merged {} (kept local edits)", ticket.key);
        }
    }
    Ok(unresolved)
}
