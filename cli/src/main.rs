//! `flat` — tickets as markdown files.
//!
//! Tracer-bullet surface: init, new, sync, push, path.

mod api;
mod markdown;
mod merge;
mod store;

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, Write};
use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
use flat_schema::{
    Entity, Mutation, MutationOp, SyncRequest, SyncResponse, Ticket, TicketSet, PROTOCOL_VERSION,
};
use serde::Deserialize;
use serde_json::{json, Value};
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
        /// Server URL, e.g. http://localhost:8787.
        server: String,
        #[arg(long, group = "enrollment")]
        setup: bool,
        #[arg(long, group = "enrollment")]
        invite: bool,
        #[arg(long, group = "enrollment")]
        recover: bool,
        #[arg(long, group = "enrollment")]
        token: bool,
        /// Name for the human token issued to this installation.
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        email: Option<String>,
        #[arg(long)]
        tenant_name: Option<String>,
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
    /// Print or rotate GitHub webhook setup.
    Github {
        #[arg(long)]
        rotate: bool,
    },
    /// Tenant member administration.
    Member {
        #[command(subcommand)]
        command: MemberCommand,
    },
    /// Token administration.
    Token {
        #[command(subcommand)]
        command: TokenCommand,
    },
    /// Audit log access.
    Audit {
        #[command(subcommand)]
        command: AuditCommand,
    },
    /// Delete a ticket (admin human token required).
    Delete { key: String },
}

#[derive(Clone, Copy, ValueEnum)]
enum RoleArg {
    Admin,
    Member,
    Viewer,
}

impl RoleArg {
    fn as_str(self) -> &'static str {
        match self {
            RoleArg::Admin => "admin",
            RoleArg::Member => "member",
            RoleArg::Viewer => "viewer",
        }
    }
}

#[derive(Subcommand)]
enum MemberCommand {
    Ls {
        #[arg(long, conflicts_with = "pending")]
        all: bool,
        #[arg(long)]
        pending: bool,
    },
    Invite {
        #[arg(required_unless_present = "file")]
        email: Option<String>,
        #[arg(long, value_enum, default_value = "member")]
        role: RoleArg,
        #[arg(long)]
        expires: Option<String>,
        #[arg(long, conflicts_with = "email", requires = "out")]
        file: Option<PathBuf>,
        #[arg(long, requires = "file")]
        out: Option<PathBuf>,
    },
    Cancel {
        email: String,
    },
    Recover {
        email: String,
    },
    Upgrade {
        email: String,
        #[arg(long)]
        replace: bool,
    },
    Suspend {
        email: String,
    },
    Reactivate {
        email: String,
    },
    Role {
        email: String,
        #[arg(value_enum)]
        role: RoleArg,
    },
}

#[derive(Clone, Copy, ValueEnum)]
enum TokenKindArg {
    Human,
    Agent,
}

impl TokenKindArg {
    fn as_str(self) -> &'static str {
        match self {
            TokenKindArg::Human => "human",
            TokenKindArg::Agent => "agent",
        }
    }
}

#[derive(Clone, Copy, ValueEnum)]
enum AccessArg {
    Read,
    Write,
    Admin,
}

impl AccessArg {
    fn as_str(self) -> &'static str {
        match self {
            AccessArg::Read => "read",
            AccessArg::Write => "write",
            AccessArg::Admin => "admin",
        }
    }
}

#[derive(Subcommand)]
enum TokenCommand {
    Create {
        #[arg(long)]
        name: String,
        #[arg(long, value_enum, default_value = "agent")]
        kind: TokenKindArg,
        #[arg(long, value_enum)]
        access: Option<AccessArg>,
        #[arg(long = "for")]
        for_email: Option<String>,
        #[arg(long)]
        expires: Option<String>,
    },
    Ls {
        #[arg(long)]
        all: bool,
    },
    Revoke {
        token_id: String,
    },
    Upgrade,
}

#[derive(Subcommand)]
enum AuditCommand {
    Ls {
        #[arg(long, default_value_t = 0)]
        after: u32,
    },
}

#[derive(Deserialize)]
struct EnrollmentResponse {
    token: String,
    snapshot: flat_schema::Snapshot,
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
        Command::Init {
            server,
            setup,
            invite,
            recover,
            token,
            name,
            email,
            tenant_name,
        } => {
            let token_name = name.unwrap_or_else(default_token_name);
            let (bearer, snapshot) = if setup {
                let credential = credential("FLAT_SETUP_CODE", "Setup code")?;
                let email = required_value(email, "Admin email")?;
                let tenant_name = required_value(tenant_name, "Tenant name")?;
                let response: EnrollmentResponse = Client::post_public(
                    &server,
                    "/setup",
                    &json!({
                        "setup_credential": credential,
                        "email": email,
                        "tenant_name": tenant_name,
                        "token_name": token_name,
                    }),
                )?;
                (response.token, response.snapshot)
            } else if invite || recover {
                let environment = if invite {
                    "FLAT_INVITATION_CODE"
                } else {
                    "FLAT_RECOVERY_CODE"
                };
                let label = if invite {
                    "Invitation code"
                } else {
                    "Recovery code"
                };
                let path = if invite {
                    "/enroll/invite"
                } else {
                    "/enroll/recover"
                };
                let response: EnrollmentResponse = Client::post_public(
                    &server,
                    path,
                    &json!({ "credential": credential(environment, label)?, "token_name": token_name }),
                )?;
                (response.token, response.snapshot)
            } else if token {
                let bearer = credential("FLAT_TOKEN", "API token")?;
                let snapshot = Client::new(&server, &bearer).snapshot()?;
                (bearer, snapshot)
            } else {
                bail!("choose one enrollment mode: --setup, --invite, --recover, or --token");
            };
            initialize_checkout(&root, server, bearer, snapshot)?;
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
                set: TicketSet {
                    title: Some(title),
                    status: None,
                    body: None,
                },
            };
            let mutation_id = mutation.mutation_id.clone();
            checkout.write_pending(&mutation)?;
            let response = send(&mut checkout, vec![])?;
            if let Some(conflict) = response
                .conflicts
                .iter()
                .find(|c| c.mutation_id == mutation_id)
            {
                bail!("create rejected: {}", conflict.reason);
            }
            let created = response
                .applied
                .iter()
                .find(|a| a.mutation_id == mutation_id)
                .context("server returned no result")?
                .clone();
            let skipped =
                checkout.apply_deltas(&response.deltas, &HashSet::new(), &HashMap::new())?;
            report_kept(&checkout, &skipped);
            if skipped.is_empty() {
                checkout.state.last_seq = response.latest_seq;
            }
            checkout.save_state()?;
            println!(
                "{}  {}",
                created.key,
                checkout.mirror_path(&created.key).display()
            );
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
            let skipped =
                checkout.apply_deltas(&response.deltas, &HashSet::new(), &HashMap::new())?;
            let unresolved = if merge {
                merge_skipped(&mut checkout, &skipped)?
            } else {
                report_kept(&checkout, &skipped);
                skipped.len()
            };
            for key in checkout.restore_missing()? {
                println!(
                    "restored {} (was deleted locally)",
                    checkout.mirror_path(&key).display()
                );
            }
            // Withheld deltas must come back on the next sync: last_seq only
            // advances once every delta has landed in the mirror. A merge
            // that wrote conflict markers did land (the base copy advanced),
            // but the marker scan below still fails the command.
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
            // Scanned, not remembered from this run: a sync retry must not
            // mistake a checkout with leftover markers for a clean one —
            // agents automate off the exit status.
            let marked = checkout.marker_files()?;
            if !marked.is_empty() {
                for path in &marked {
                    eprintln!("unresolved conflict markers in {}", path.display());
                }
                bail!(
                    "{} file(s) have conflict markers to resolve; edit them away, then `flat push`",
                    marked.len()
                );
            }
            println!(
                "synced {} tickets (seq {})",
                response.deltas.len(),
                response.latest_seq
            );
        }
        Command::Push => {
            push(&mut Checkout::open(&root)?)?;
        }
        Command::Path => {
            println!("{}", Checkout::open(&root)?.host_dir().display());
        }
        Command::Github { rotate } => {
            let checkout = Checkout::open(&root)?;
            if rotate {
                eprintln!("warning: rotating invalidates the secret configured in every existing GitHub webhook");
            }
            let path = if rotate {
                "/hooks/github/setup?rotate=1"
            } else {
                "/hooks/github/setup"
            };
            let response: Value = client(&checkout).post(path, &json!({}))?;
            let secret = response
                .get("secret")
                .and_then(Value::as_str)
                .context("server returned no webhook secret")?;
            println!(
                "Payload URL:  {}/hooks/github",
                checkout.config.server.trim_end_matches('/')
            );
            println!("Content type: application/json");
            println!("Secret:       {secret}");
            println!("Events:       Pull requests");
            println!("\nGitHub -> repository or organization Settings -> Webhooks -> Add webhook");
            if checkout.config.server.starts_with("http://localhost")
                || checkout.config.server.starts_with("http://127.0.0.1")
            {
                eprintln!("warning: GitHub cannot deliver to a localhost URL; use this output for fixture tests or configure a separate tunnel");
            }
        }
        Command::Member { command } => run_member(&Checkout::open(&root)?, command)?,
        Command::Token { command } => run_token(&Checkout::open(&root)?, command)?,
        Command::Audit { command } => run_audit(&Checkout::open(&root)?, command)?,
        Command::Delete { key } => delete_ticket(&mut Checkout::open(&root)?, &key)?,
    }
    Ok(())
}

fn client(checkout: &Checkout) -> Client {
    Client::new(&checkout.config.server, &checkout.config.token)
}

fn initialize_checkout(
    root: &std::path::Path,
    server: String,
    token: String,
    snapshot: flat_schema::Snapshot,
) -> Result<()> {
    store::save_config(root, &Config { server, token })?;
    let mut checkout = Checkout::open(root)?;
    checkout.reset()?;
    checkout.apply_deltas(&snapshot.tickets, &HashSet::new(), &HashMap::new())?;
    checkout.state.last_seq = snapshot.latest_seq;
    checkout.save_state()?;
    println!(
        "initialized {} ({} tickets, seq {})",
        checkout.mirror_dir().display(),
        snapshot.tickets.len(),
        snapshot.latest_seq
    );
    Ok(())
}

fn default_token_name() -> String {
    std::env::var("HOSTNAME")
        .ok()
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "flat-cli".to_string())
}

fn prompt(label: &str) -> Result<String> {
    print!("{label}: ");
    io::stdout().flush()?;
    let mut value = String::new();
    io::stdin().read_line(&mut value)?;
    let value = value.trim().to_string();
    if value.is_empty() {
        bail!("{label} is required");
    }
    Ok(value)
}

fn credential(environment: &str, label: &str) -> Result<String> {
    match std::env::var(environment) {
        Ok(value) if !value.is_empty() => Ok(value),
        _ => prompt(label),
    }
}

fn required_value(value: Option<String>, label: &str) -> Result<String> {
    match value {
        Some(value) if !value.trim().is_empty() => Ok(value),
        _ => prompt(label),
    }
}

fn duration_seconds(value: &str) -> Result<u64> {
    let split = value
        .find(|character: char| !character.is_ascii_digit())
        .unwrap_or(value.len());
    let amount: u64 = value[..split]
        .parse()
        .with_context(|| format!("invalid duration {value:?}"))?;
    let multiplier = match &value[split..] {
        "s" => 1,
        "m" => 60,
        "h" => 60 * 60,
        "d" => 24 * 60 * 60,
        _ => bail!("invalid duration {value:?}; use s, m, h, or d"),
    };
    amount
        .checked_mul(multiplier)
        .context("duration is too large")
}

fn print_json(value: &Value) -> Result<()> {
    if value.is_null() {
        return Ok(());
    }
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

fn bulk_invite(
    api: &Client,
    input: &std::path::Path,
    output: &std::path::Path,
    expires: Option<u64>,
) -> Result<()> {
    let raw = fs::read_to_string(input).with_context(|| format!("reading {}", input.display()))?;
    let mut lines = raw.lines();
    if lines.next().map(str::trim) != Some("email,role") {
        bail!("{} must start with the header email,role", input.display());
    }
    let mut members = Vec::new();
    for (index, line) in lines.enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.split(',').collect();
        if fields.len() != 2 {
            bail!("{}:{} must contain email,role", input.display(), index + 2);
        }
        let role = fields[1].trim();
        if !matches!(role, "admin" | "member" | "viewer") {
            bail!(
                "{}:{} has invalid role {role:?}",
                input.display(),
                index + 2
            );
        }
        members.push(json!({ "email": fields[0].trim(), "role": role }));
    }
    if members.is_empty() {
        bail!("{} contains no invitations", input.display());
    }

    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut output_file = options
        .open(output)
        .with_context(|| format!("creating {}", output.display()))?;
    let mut body = json!({ "members": members });
    if let Some(expires) = expires {
        body["expires_in_seconds"] = json!(expires);
    }
    let response: Value = match api.post("/members/invite", &body) {
        Ok(response) => response,
        Err(error) => {
            drop(output_file);
            let _ = fs::remove_file(output);
            return Err(error);
        }
    };
    let invitations = response
        .get("invitations")
        .and_then(Value::as_array)
        .context("server returned no invitations")?;
    writeln!(output_file, "email,role,expires_at,invitation_code")?;
    for invitation in invitations {
        let field = |name: &str| {
            invitation
                .get(name)
                .and_then(Value::as_str)
                .unwrap_or_default()
        };
        writeln!(
            output_file,
            "{},{},{},{}",
            csv_field(field("email")),
            csv_field(field("role")),
            csv_field(field("expires_at")),
            csv_field(field("invitation_code")),
        )?;
    }
    output_file.flush()?;
    println!(
        "wrote {} invitation(s) to {}",
        invitations.len(),
        output.display()
    );
    Ok(())
}

fn csv_field(value: &str) -> String {
    if !value.contains([',', '"', '\n', '\r']) {
        return value.to_string();
    }
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn run_member(checkout: &Checkout, command: MemberCommand) -> Result<()> {
    let api = client(checkout);
    let response: Value = match command {
        MemberCommand::Ls { all, pending } => {
            let query = if all {
                "?all=1"
            } else if pending {
                "?pending=1"
            } else {
                ""
            };
            api.get(&format!("/members{query}"))?
        }
        MemberCommand::Invite {
            email,
            role,
            expires,
            file,
            out,
        } => {
            let expires = expires.as_deref().map(duration_seconds).transpose()?;
            if let Some(file) = file {
                return bulk_invite(
                    &api,
                    &file,
                    &out.context("--out is required with --file")?,
                    expires,
                );
            }
            let mut body = json!({
                "email": email.context("EMAIL is required")?,
                "role": role.as_str(),
            });
            if let Some(expires) = expires {
                body["expires_in_seconds"] = json!(expires);
            }
            api.post("/members/invite", &body)?
        }
        MemberCommand::Cancel { email } => {
            api.post("/members/cancel", &json!({ "email": email }))?
        }
        MemberCommand::Recover { email } => {
            api.post("/members/recover", &json!({ "email": email }))?
        }
        MemberCommand::Upgrade { email, replace } => api.post(
            "/members/upgrade",
            &json!({ "email": email, "replace": replace }),
        )?,
        MemberCommand::Suspend { email } => {
            api.post("/members/suspend", &json!({ "email": email }))?
        }
        MemberCommand::Reactivate { email } => {
            api.post("/members/reactivate", &json!({ "email": email }))?
        }
        MemberCommand::Role { email, role } => api.post(
            "/members/role",
            &json!({ "email": email, "role": role.as_str() }),
        )?,
    };
    print_json(&response)
}

fn run_token(checkout: &Checkout, command: TokenCommand) -> Result<()> {
    let api = client(checkout);
    let response: Value = match command {
        TokenCommand::Create {
            name,
            kind,
            access,
            for_email,
            expires,
        } => {
            let expires = expires.as_deref().map(duration_seconds).transpose()?;
            let mut body = json!({
                "name": name,
                "kind": kind.as_str(),
            });
            if let Some(access) = access {
                body["access"] = json!(access.as_str());
            }
            if let Some(for_email) = for_email {
                body["for_email"] = json!(for_email);
            }
            if let Some(expires) = expires {
                body["expires_in_seconds"] = json!(expires);
            }
            api.post("/tokens", &body)?
        }
        TokenCommand::Ls { all } => {
            let query = if all { "?all=1" } else { "" };
            api.get(&format!("/tokens{query}"))?
        }
        TokenCommand::Revoke { token_id } => {
            api.post("/tokens/revoke", &json!({ "token_id": token_id }))?
        }
        TokenCommand::Upgrade => {
            let code = credential("FLAT_UPGRADE_CODE", "Upgrade code")?;
            api.post("/tokens/upgrade", &json!({ "credential": code }))?
        }
    };
    print_json(&response)
}

fn run_audit(checkout: &Checkout, command: AuditCommand) -> Result<()> {
    let response: Value = match command {
        AuditCommand::Ls { after } => client(checkout).get(&format!("/audit?after={after}"))?,
    };
    print_json(&response)
}

fn delete_ticket(checkout: &mut Checkout, key: &str) -> Result<()> {
    let state = checkout
        .state
        .tickets
        .get(key)
        .with_context(|| format!("unknown local ticket {key}"))?
        .clone();
    let mutation = Mutation {
        mutation_id: Ulid::new().to_string(),
        op: MutationOp::Delete,
        entity: Entity::Ticket,
        entity_id: state.id,
        base_seq: Some(state.seq),
        set: TicketSet::default(),
    };
    let mutation_id = mutation.mutation_id.clone();
    let response = send(checkout, vec![mutation])?;
    if let Some(conflict) = response
        .conflicts
        .iter()
        .find(|conflict| conflict.mutation_id == mutation_id)
    {
        bail!("delete rejected: {}", conflict.reason);
    }
    response
        .applied
        .iter()
        .find(|applied| applied.mutation_id == mutation_id)
        .context("server returned no result")?;
    for path in [checkout.mirror_path(key), checkout.base_path(key)] {
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).with_context(|| format!("removing {}", path.display()))
            }
        }
    }
    checkout.state.tickets.remove(key);
    checkout.state.last_seq = response.latest_seq;
    checkout.save_state()?;
    println!("deleted {key}");
    Ok(())
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
    // The exact bytes each mutation was built from: after the push, a mirror
    // file may only be clobbered if it still matches (an edit saved while the
    // request was in flight is not on the server and must survive).
    let mut pushed = HashMap::new();

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
                eprintln!(
                    "warning: {} is not a synced ticket (use `flat new`); skipped",
                    path.display()
                );
                continue;
            }
        };

        let content = fs::read_to_string(&path)?;
        // Frontmatter markers already fail the parse below; this catches
        // markers in the freeform body, which would otherwise push silently.
        if merge::has_markers(&content) {
            bail!(
                "{} has unresolved conflict markers; edit them away and push again",
                path.display()
            );
        }
        let file =
            markdown::parse(&content).with_context(|| format!("parsing {}", path.display()))?;
        if file.key != stem {
            bail!(
                "{}: id is read-only (file says {:?}, expected {:?})",
                path.display(),
                file.key,
                stem
            );
        }
        let base_content = fs::read_to_string(checkout.base_path(&stem))
            .with_context(|| format!("no base copy for {stem} — run `flat sync`"))?;
        let base = markdown::parse(&base_content)
            .with_context(|| format!("parsing base copy of {stem}"))?;

        // One mutation carries every changed field: atomic per ticket.
        let set = TicketSet {
            title: (file.title != base.title).then(|| file.title.clone()),
            status: (file.status != base.status).then_some(file.status),
            body: (file.body != base.body).then(|| file.body.clone()),
        };
        if set == TicketSet::default() {
            continue;
        }
        pushed.insert(stem.clone(), content);
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
    let conflicted: HashSet<String> = response
        .conflicts
        .iter()
        .map(|c| key_of(&c.entity_id))
        .collect();
    for conflict in &response.conflicts {
        eprintln!(
            "rejected {}: {}",
            key_of(&conflict.entity_id),
            conflict.reason
        );
    }

    // Conflicted files keep their local edits. A file whose pushed content is
    // unchanged may be clobbered by its own delta: those edits are now server
    // state (the row folds them together with whatever disjoint fields the
    // server changed). last_seq only advances on a clean push so a later sync
    // re-delivers anything skipped here.
    let skipped = checkout.apply_deltas(&response.deltas, &conflicted, &pushed)?;
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
/// how many were left untouched (unparseable local files); merges that wrote
/// conflict markers are picked up by the caller's marker scan.
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
        if !merged.conflicted {
            println!("merged {} (kept local edits)", ticket.key);
        }
    }
    Ok(unresolved)
}
