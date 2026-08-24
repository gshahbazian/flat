//! `flat` — tickets as markdown files.
//!
//! Tracer-bullet surface: init, new, sync, push, path.

mod api;
mod markdown;
mod store;

use std::collections::HashSet;
use std::fs;

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use flat_schema::{
    Entity, Mutation, MutationOp, SyncRequest, SyncResponse, TicketSet, PROTOCOL_VERSION,
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
    Sync,
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
            store::save_config(&root, &Config { server, token })?;
            let mut checkout = Checkout::open(&root)?;
            let client = client(&checkout);
            let snapshot = client.snapshot()?;
            checkout.apply_deltas(&snapshot.tickets, &HashSet::new())?;
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
            let mut checkout = Checkout::open(&root)?;
            let mutation = Mutation {
                mutation_id: Ulid::new().to_string(),
                op: MutationOp::Create,
                entity: Entity::Ticket,
                entity_id: Ulid::new().to_string(),
                base_seq: None,
                set: TicketSet { title: Some(title), status: None, body: None },
            };
            let response = send(&mut checkout, vec![mutation])?;
            let created = response.applied.first().context("server applied nothing")?;
            checkout.apply_deltas(&response.deltas, &HashSet::new())?;
            checkout.state.last_seq = response.latest_seq;
            checkout.save_state()?;
            println!("{}  {}", created.key, checkout.mirror_path(&created.key).display());
        }
        Command::Sync => {
            let mut checkout = Checkout::open(&root)?;
            let response = send(&mut checkout, vec![])?;
            checkout.apply_deltas(&response.deltas, &HashSet::new())?;
            checkout.state.last_seq = response.latest_seq;
            checkout.save_state()?;
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

fn send(checkout: &mut Checkout, mutations: Vec<Mutation>) -> Result<SyncResponse> {
    client(checkout).sync(&SyncRequest {
        protocol_version: PROTOCOL_VERSION,
        last_seq: checkout.state.last_seq,
        mutations,
    })
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

    // Conflicted files keep their local edits. last_seq only advances on a
    // clean push so a later sync re-delivers what we skipped here.
    checkout.apply_deltas(&response.deltas, &conflicted)?;
    if conflicted.is_empty() {
        checkout.state.last_seq = response.latest_seq;
    }
    checkout.save_state()?;

    if !conflicted.is_empty() {
        bail!("{} ticket(s) rejected; run `flat sync` to update (local edits will be overwritten)", conflicted.len());
    }
    Ok(())
}
