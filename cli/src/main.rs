//! `flat` — tickets as markdown files.
//!
//! CLI entry point for ticket, comment, project, and tenant operations.

mod api;
mod markdown;
mod merge;
mod store;

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::io::{self, Read, Write};
use std::path::Path;
use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
use flat_schema::{
    Entity, Label, Mutation, MutationOp, MutationSet, Priority, Project, SearchRequest,
    SearchResponse, SearchSort, SyncRequest, SyncResponse, Ticket, TicketSet, PROTOCOL_VERSION,
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
    New {
        title: String,
        /// Project key, e.g. AUTH.
        #[arg(long)]
        project: String,
        #[arg(long)]
        priority: Option<Priority>,
        #[arg(long)]
        assignee: Option<String>,
        #[arg(long = "label")]
        labels: Vec<String>,
    },
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
    /// Search accepted server ticket state.
    Search {
        /// Flat search query. Quote this shell argument when it contains spaces.
        query: String,
        #[arg(long, value_enum)]
        sort: Option<SearchSortArg>,
        #[arg(long)]
        limit: Option<u32>,
        #[arg(long)]
        cursor: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Add an append-only Markdown comment to a ticket.
    Comment {
        key: String,
        #[arg(required_unless_present = "stdin", conflicts_with = "stdin")]
        text: Option<String>,
        #[arg(long)]
        stdin: bool,
    },
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
    /// Project administration.
    Project {
        #[command(subcommand)]
        command: ProjectCommand,
    },
    /// Label administration.
    Label {
        #[command(subcommand)]
        command: LabelCommand,
    },
    /// Delete a ticket (admin human token required).
    Delete { key: String },
}

#[derive(Subcommand)]
enum ProjectCommand {
    Ls,
    Show {
        key: String,
    },
    Create {
        key: String,
        #[arg(long)]
        name: String,
        #[arg(long, default_value = "")]
        description: String,
    },
    Update {
        key: String,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        description: Option<String>,
    },
    Owner {
        #[command(subcommand)]
        command: ProjectOwnerCommand,
    },
    Delete {
        key: String,
    },
}

#[derive(Subcommand)]
enum LabelCommand {
    Ls,
    Show {
        name: String,
    },
    Create {
        name: String,
    },
    Update {
        name: String,
        #[arg(long)]
        new_name: String,
    },
    Delete {
        name: String,
    },
}

#[derive(Subcommand)]
enum ProjectOwnerCommand {
    Add { key: String, email: String },
    Remove { key: String, email: String },
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

#[derive(Clone, Copy, ValueEnum)]
enum SearchSortArg {
    Relevance,
    Updated,
    Created,
}

impl From<SearchSortArg> for SearchSort {
    fn from(value: SearchSortArg) -> Self {
        match value {
            SearchSortArg::Relevance => SearchSort::Relevance,
            SearchSortArg::Updated => SearchSort::Updated,
            SearchSortArg::Created => SearchSort::Created,
        }
    }
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
            if !setup && !invite && !recover && !token {
                bail!("choose one enrollment mode: --setup, --invite, --recover, or --token");
            }
            store::preflight_init(&root, &server)?;
            let token_name = if setup || invite || recover {
                new_token_name(name)?
            } else {
                String::new()
            };
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
                    &json!({
                        "credential": credential(environment, label)?,
                        "token_name": token_name,
                    }),
                )?;
                (response.token, response.snapshot)
            } else if token {
                let bearer = credential("FLAT_TOKEN", "API token")?;
                let snapshot = Client::new(&server, &bearer).snapshot()?;
                (bearer, snapshot)
            } else {
                unreachable!("enrollment mode validated before preflight")
            };
            initialize_checkout(&root, server, bearer, snapshot)?;
        }
        Command::New {
            title,
            project,
            priority,
            assignee,
            labels,
        } => {
            let title = title.trim().to_string();
            flat_schema::validate_title(&title).map_err(anyhow::Error::msg)?;
            flat_schema::validate_project_key(&project).map_err(anyhow::Error::msg)?;
            let mut checkout = Checkout::open(&root)?;
            require_empty_journal(&checkout)?;
            let project_id = checkout.project(&project)?.id.clone();
            let assignee = assignee
                .as_deref()
                .map(|email| checkout.resolve_assignee(email).map(Some))
                .transpose()?;
            let labels = resolve_label_names(&checkout, &labels)?;
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
                    project: Some(project_id),
                    title: Some(title),
                    status: None,
                    priority,
                    assignee,
                    body: None,
                    ..TicketSet::default()
                },
                owners_add: Vec::new(),
                owners_remove: Vec::new(),
                labels_add: labels,
                labels_remove: Vec::new(),
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
            checkout.apply_projects(&response.project_deltas);
            checkout.apply_labels(&response.label_deltas);
            let skipped =
                checkout.apply_deltas(&response.deltas, &HashSet::new(), &HashMap::new())?;
            checkout.apply_tombstones(&response.tombstones)?;
            checkout.apply_project_tombstones(&response.project_tombstones)?;
            checkout.apply_label_tombstones(&response.label_tombstones);
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
            checkout.apply_projects(&response.project_deltas);
            checkout.apply_labels(&response.label_deltas);
            let skipped =
                checkout.apply_deltas(&response.deltas, &HashSet::new(), &HashMap::new())?;
            checkout.apply_tombstones(&response.tombstones)?;
            checkout.apply_project_tombstones(&response.project_tombstones)?;
            checkout.apply_label_tombstones(&response.label_tombstones);
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
            let changed = response.deltas.len()
                + response.project_deltas.len()
                + response.label_deltas.len()
                + response.tombstones.len()
                + response.project_tombstones.len()
                + response.label_tombstones.len();
            println!(
                "synced {changed} changes ({} tickets deleted, {} projects deleted, {} labels deleted, seq {})",
                response.tombstones.len(),
                response.project_tombstones.len(),
                response.label_tombstones.len(),
                response.latest_seq
            );
        }
        Command::Push => {
            push(&mut Checkout::open(&root)?)?;
        }
        Command::Search {
            query,
            sort,
            limit,
            cursor,
            json,
        } => {
            let config = store::load_config(&root)?;
            let response = Client::new(&config.server, &config.token).search(&SearchRequest {
                query,
                sort: sort.map(SearchSort::from),
                limit,
                cursor,
            })?;
            if json {
                print_json(&serde_json::to_value(response)?)?;
            } else {
                print!("{}", format_search_response(&response));
            }
        }
        Command::Comment { key, text, stdin } => {
            comment(&mut Checkout::open(&root)?, &key, text, stdin)?;
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
        Command::Project { command } => run_project(&mut Checkout::open(&root)?, command)?,
        Command::Label { command } => run_label(&mut Checkout::open(&root)?, command)?,
        Command::Delete { key } => delete_ticket(&mut Checkout::open(&root)?, &key)?,
    }
    Ok(())
}

fn client(checkout: &Checkout) -> Client {
    Client::new(&checkout.config.server, &checkout.config.token)
}

fn format_search_response(response: &SearchResponse) -> String {
    let mut output = String::new();
    for result in &response.results {
        let assignee = result.assignee.as_deref().unwrap_or("-");
        output.push_str(&format!(
            "{}  {}  {}  {}  {}\n",
            result.key,
            result.status.as_str(),
            result.priority.as_str(),
            assignee,
            result.title
        ));
        if let Some(excerpt) = &result.r#match.excerpt {
            let excerpt = excerpt.split_whitespace().collect::<Vec<_>>().join(" ");
            output.push_str(&format!("  {excerpt}\n"));
        }
    }
    if let Some(cursor) = &response.next_cursor {
        output.push_str(&format!("next cursor: {cursor}\n"));
    }
    output
}

fn initialize_checkout(
    root: &std::path::Path,
    server: String,
    token: String,
    snapshot: flat_schema::Snapshot,
) -> Result<()> {
    let config = Config { server, token };
    // Persist the only copy of a newly issued bearer token before rebuilding
    // the mirror. A failed rebuild can then be retried without re-enrollment.
    store::save_config(root, &config)?;
    let mut checkout = Checkout::initialize(root, config)?;
    checkout.reset()?;
    checkout.update_members(&snapshot.members);
    checkout.update_comments(&snapshot.comments);
    checkout.apply_projects(&snapshot.projects);
    checkout.apply_labels(&snapshot.labels);
    checkout.apply_deltas(&snapshot.tickets, &HashSet::new(), &HashMap::new())?;
    checkout.state.last_seq = snapshot.latest_seq;
    checkout.save_state()?;
    println!(
        "initialized {} ({} projects, {} labels, {} tickets, seq {})",
        checkout.host_dir().display(),
        snapshot.projects.len(),
        snapshot.labels.len(),
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

fn new_token_name(explicit: Option<String>) -> Result<String> {
    if let Some(name) = explicit {
        let name = name.trim().to_string();
        flat_schema::validate_token_name(&name).map_err(anyhow::Error::msg)?;
        return Ok(name);
    }

    let hostname = default_token_name();
    let name = if flat_schema::validate_token_name(&hostname).is_ok() {
        prompt_default("Token name", &hostname)?
    } else {
        eprintln!("local hostname {hostname:?} is not a valid token name");
        prompt("Token name")?
    };
    flat_schema::validate_token_name(&name).map_err(anyhow::Error::msg)?;
    Ok(name)
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

fn prompt_default(label: &str, default: &str) -> Result<String> {
    print!("{label} [{default}]: ");
    io::stdout().flush()?;
    let mut value = String::new();
    io::stdin().read_line(&mut value)?;
    let value = value.trim();
    if value.is_empty() {
        return Ok(default.to_string());
    }
    Ok(value.to_string())
}

fn credential(environment: &str, label: &str) -> Result<String> {
    match std::env::var(environment) {
        Ok(value) if !value.is_empty() => Ok(value),
        _ => {
            let value = rpassword::prompt_password(format!("{label}: "))?;
            let value = value.trim().to_string();
            if value.is_empty() {
                bail!("{label} is required");
            }
            Ok(value)
        }
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
    if output == std::path::Path::new("-") {
        bail!("--out - is not allowed; invitation secrets must be written to a private file");
    }
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

fn run_project(checkout: &mut Checkout, command: ProjectCommand) -> Result<()> {
    match command {
        ProjectCommand::Ls => {
            let projects: Vec<Value> = checkout
                .state
                .projects
                .values()
                .map(|project| project_json(checkout, project))
                .collect();
            print_json(&json!({ "projects": projects }))
        }
        ProjectCommand::Show { key } => {
            print_json(&project_json(checkout, checkout.project(&key)?))
        }
        ProjectCommand::Create {
            key,
            name,
            description,
        } => {
            flat_schema::validate_project_key(&key).map_err(anyhow::Error::msg)?;
            let name = name.trim().to_string();
            flat_schema::validate_project_name(&name).map_err(anyhow::Error::msg)?;
            require_empty_journal(checkout)?;
            let mutation = Mutation {
                mutation_id: Ulid::new().to_string(),
                op: MutationOp::Create,
                entity: Entity::Project,
                entity_id: Ulid::new().to_string(),
                base_seq: None,
                set: MutationSet {
                    key: Some(key),
                    display_name: Some(name),
                    description: Some(description),
                    ..MutationSet::default()
                },
                owners_add: Vec::new(),
                owners_remove: Vec::new(),
                labels_add: Vec::new(),
                labels_remove: Vec::new(),
            };
            checkout.write_pending(&mutation)?;
            execute_project_mutation(
                checkout,
                mutation.mutation_id.clone(),
                Vec::new(),
                "created",
            )
        }
        ProjectCommand::Update {
            key,
            name,
            description,
        } => {
            if name.is_none() && description.is_none() {
                bail!("provide --name or --description");
            }
            let project = checkout.project(&key)?.clone();
            let name = name
                .map(|name| {
                    let name = name.trim().to_string();
                    flat_schema::validate_project_name(&name)
                        .map(|()| name)
                        .map_err(anyhow::Error::msg)
                })
                .transpose()?;
            let mutation = project_update_mutation(
                &project,
                MutationSet {
                    display_name: name,
                    description,
                    ..MutationSet::default()
                },
                Vec::new(),
                Vec::new(),
            );
            execute_project_mutation(
                checkout,
                mutation.mutation_id.clone(),
                vec![mutation],
                "updated",
            )
        }
        ProjectCommand::Owner { command } => {
            let (key, email, add) = match command {
                ProjectOwnerCommand::Add { key, email } => (key, email, true),
                ProjectOwnerCommand::Remove { key, email } => (key, email, false),
            };
            let project = checkout.project(&key)?.clone();
            let member_id = checkout.resolve_member(&email)?;
            let (owners_add, owners_remove) = if add {
                (vec![member_id], Vec::new())
            } else {
                (Vec::new(), vec![member_id])
            };
            let mutation = project_update_mutation(
                &project,
                MutationSet::default(),
                owners_add,
                owners_remove,
            );
            execute_project_mutation(
                checkout,
                mutation.mutation_id.clone(),
                vec![mutation],
                "updated",
            )
        }
        ProjectCommand::Delete { key } => {
            let project = checkout.project(&key)?.clone();
            let mutation = Mutation {
                mutation_id: Ulid::new().to_string(),
                op: MutationOp::Delete,
                entity: Entity::Project,
                entity_id: project.id,
                base_seq: Some(project.seq),
                set: MutationSet::default(),
                owners_add: Vec::new(),
                owners_remove: Vec::new(),
                labels_add: Vec::new(),
                labels_remove: Vec::new(),
            };
            execute_project_mutation(
                checkout,
                mutation.mutation_id.clone(),
                vec![mutation],
                "deleted",
            )
        }
    }
}

fn project_update_mutation(
    project: &Project,
    set: MutationSet,
    owners_add: Vec<String>,
    owners_remove: Vec<String>,
) -> Mutation {
    Mutation {
        mutation_id: Ulid::new().to_string(),
        op: MutationOp::Update,
        entity: Entity::Project,
        entity_id: project.id.clone(),
        base_seq: Some(project.seq),
        set,
        owners_add,
        owners_remove,
        labels_add: Vec::new(),
        labels_remove: Vec::new(),
    }
}

fn execute_project_mutation(
    checkout: &mut Checkout,
    mutation_id: String,
    mutations: Vec<Mutation>,
    verb: &str,
) -> Result<()> {
    let response = send(checkout, mutations)?;
    apply_sync_changes(checkout, &response)?;
    if let Some(conflict) = response
        .conflicts
        .iter()
        .find(|conflict| conflict.mutation_id == mutation_id)
    {
        bail!("project mutation rejected: {}", conflict.reason);
    }
    let applied = response
        .applied
        .iter()
        .find(|applied| applied.mutation_id == mutation_id)
        .context("server returned no project mutation result")?;
    println!("{verb} {}", applied.key);
    Ok(())
}

fn project_json(checkout: &Checkout, project: &Project) -> Value {
    let owners: Vec<&str> = project
        .owner_ids
        .iter()
        .map(|member_id| {
            checkout
                .state
                .members
                .get(member_id)
                .map_or(member_id.as_str(), |member| member.email.as_str())
        })
        .collect();
    json!({
        "key": project.key,
        "display_name": project.display_name,
        "description": project.description,
        "owners": owners,
        "created_at": project.created_at,
        "updated_at": project.updated_at,
    })
}

fn run_label(checkout: &mut Checkout, command: LabelCommand) -> Result<()> {
    match command {
        LabelCommand::Ls => {
            let labels: Vec<Value> = checkout.state.labels.values().map(label_json).collect();
            print_json(&json!({ "labels": labels }))
        }
        LabelCommand::Show { name } => print_json(&label_json(checkout.label(&name)?)),
        LabelCommand::Create { name } => {
            let name = flat_schema::normalize_label_name(&name).map_err(anyhow::Error::msg)?;
            require_empty_journal(checkout)?;
            let mutation = Mutation {
                mutation_id: Ulid::new().to_string(),
                op: MutationOp::Create,
                entity: Entity::Label,
                entity_id: Ulid::new().to_string(),
                base_seq: None,
                set: MutationSet {
                    name: Some(name),
                    ..MutationSet::default()
                },
                owners_add: Vec::new(),
                owners_remove: Vec::new(),
                labels_add: Vec::new(),
                labels_remove: Vec::new(),
            };
            let mutation_id = mutation.mutation_id.clone();
            checkout.write_pending(&mutation)?;
            execute_label_mutation(checkout, mutation_id, Vec::new(), "created")
        }
        LabelCommand::Update { name, new_name } => {
            let label = checkout.label(&name)?.clone();
            let new_name =
                flat_schema::normalize_label_name(&new_name).map_err(anyhow::Error::msg)?;
            let mutation = Mutation {
                mutation_id: Ulid::new().to_string(),
                op: MutationOp::Update,
                entity: Entity::Label,
                entity_id: label.id,
                base_seq: Some(label.seq),
                set: MutationSet {
                    name: Some(new_name),
                    ..MutationSet::default()
                },
                owners_add: Vec::new(),
                owners_remove: Vec::new(),
                labels_add: Vec::new(),
                labels_remove: Vec::new(),
            };
            execute_label_mutation(
                checkout,
                mutation.mutation_id.clone(),
                vec![mutation],
                "updated",
            )
        }
        LabelCommand::Delete { name } => {
            let label = checkout.label(&name)?.clone();
            let mutation = Mutation {
                mutation_id: Ulid::new().to_string(),
                op: MutationOp::Delete,
                entity: Entity::Label,
                entity_id: label.id,
                base_seq: Some(label.seq),
                set: MutationSet::default(),
                owners_add: Vec::new(),
                owners_remove: Vec::new(),
                labels_add: Vec::new(),
                labels_remove: Vec::new(),
            };
            execute_label_mutation(
                checkout,
                mutation.mutation_id.clone(),
                vec![mutation],
                "deleted",
            )
        }
    }
}

fn execute_label_mutation(
    checkout: &mut Checkout,
    mutation_id: String,
    mutations: Vec<Mutation>,
    verb: &str,
) -> Result<()> {
    let response = send(checkout, mutations)?;
    apply_sync_changes(checkout, &response)?;
    if let Some(conflict) = response
        .conflicts
        .iter()
        .find(|conflict| conflict.mutation_id == mutation_id)
    {
        bail!("label mutation rejected: {}", conflict.reason);
    }
    let applied = response
        .applied
        .iter()
        .find(|applied| applied.mutation_id == mutation_id)
        .context("server returned no label mutation result")?;
    println!("{verb} {}", applied.key);
    Ok(())
}

fn label_json(label: &Label) -> Value {
    json!({
        "name": label.name,
        "created_at": label.created_at,
        "updated_at": label.updated_at,
    })
}

fn resolve_label_names(checkout: &Checkout, names: &[String]) -> Result<Vec<String>> {
    let mut normalized = HashSet::new();
    let mut ids = Vec::new();
    for name in names {
        let name = flat_schema::normalize_label_name(name).map_err(anyhow::Error::msg)?;
        if !normalized.insert(name.clone()) {
            bail!("duplicate label {name:?}");
        }
        ids.push(checkout.resolve_label(&name)?);
    }
    Ok(ids)
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
        owners_add: Vec::new(),
        owners_remove: Vec::new(),
        labels_add: Vec::new(),
        labels_remove: Vec::new(),
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
    apply_delete_changes(checkout, &response)?;
    println!("deleted {key}");
    Ok(())
}

fn comment(checkout: &mut Checkout, key: &str, text: Option<String>, stdin: bool) -> Result<()> {
    let body = if stdin {
        let mut body = String::new();
        io::stdin().read_to_string(&mut body)?;
        body
    } else {
        text.context("comment text is required unless --stdin is used")?
    };
    flat_schema::validate_comment_body(&body).map_err(anyhow::Error::msg)?;
    require_empty_journal(checkout)?;
    let ticket = checkout
        .state
        .tickets
        .get(key)
        .with_context(|| format!("unknown local ticket {key}; run `flat sync`"))?
        .clone();
    let mutation = Mutation {
        mutation_id: Ulid::new().to_string(),
        op: MutationOp::Create,
        entity: Entity::Comment,
        entity_id: Ulid::new().to_string(),
        base_seq: None,
        set: MutationSet {
            ticket: Some(ticket.id),
            body: Some(body),
            ..MutationSet::default()
        },
        owners_add: Vec::new(),
        owners_remove: Vec::new(),
        labels_add: Vec::new(),
        labels_remove: Vec::new(),
    };
    let mutation_id = mutation.mutation_id.clone();
    checkout.write_pending(&mutation)?;
    let response = send(checkout, Vec::new())?;
    if let Some(conflict) = response
        .conflicts
        .iter()
        .find(|conflict| conflict.mutation_id == mutation_id)
    {
        bail!("comment rejected: {}", conflict.reason);
    }
    response
        .applied
        .iter()
        .find(|applied| applied.mutation_id == mutation_id)
        .context("server returned no comment result")?;
    apply_sync_changes(checkout, &response)?;
    println!("commented {key}");
    Ok(())
}

fn apply_delete_changes(checkout: &mut Checkout, response: &SyncResponse) -> Result<Vec<Ticket>> {
    apply_sync_changes(checkout, response)
}

fn apply_sync_changes(checkout: &mut Checkout, response: &SyncResponse) -> Result<Vec<Ticket>> {
    checkout.apply_projects(&response.project_deltas);
    checkout.apply_labels(&response.label_deltas);
    let skipped = checkout.apply_deltas(&response.deltas, &HashSet::new(), &HashMap::new())?;
    checkout.apply_tombstones(&response.tombstones)?;
    checkout.apply_project_tombstones(&response.project_tombstones)?;
    checkout.apply_label_tombstones(&response.label_tombstones);
    report_kept(checkout, &skipped);
    if skipped.is_empty() {
        checkout.state.last_seq = response.latest_seq;
    }
    checkout.save_state()?;
    Ok(skipped)
}

fn require_empty_journal(checkout: &Checkout) -> Result<()> {
    if checkout.pending_mutations()?.is_empty() {
        return Ok(());
    }
    bail!(
        "a previous mutation may not have reached the server; run `flat sync` to replay it first"
    );
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
    checkout.update_members(&response.members);
    checkout.update_comments(&response.comment_deltas);
    Ok(response)
}

#[derive(Debug)]
struct TicketChanges {
    set: TicketSet,
    labels_add: Vec<String>,
    labels_remove: Vec<String>,
}

impl TicketChanges {
    fn is_empty(&self) -> bool {
        self.set == TicketSet::default()
            && self.labels_add.is_empty()
            && self.labels_remove.is_empty()
    }
}

fn changed_ticket_set(
    checkout: &Checkout,
    file: &markdown::TicketFile,
    base: &markdown::TicketFile,
    path: &Path,
) -> Result<TicketChanges> {
    flat_schema::validate_ticket_body(&file.body).map_err(anyhow::Error::msg)?;
    if file.project != base.project {
        bail!("{}: project is read-only", path.display());
    }
    if file.created != base.created {
        bail!("{}: created is read-only", path.display());
    }
    if file.updated != base.updated {
        bail!("{}: updated is read-only", path.display());
    }
    if !markdown::comment_sections_equal(&file.comments, &base.comments) {
        bail!(
            "{}: comments are read-only — use `flat comment {}`",
            path.display(),
            file.key
        );
    }

    let assignee = if file.assignee != base.assignee {
        Some(
            file.assignee
                .as_deref()
                .map(|email| checkout.resolve_assignee(email))
                .transpose()?,
        )
    } else {
        None
    };
    let base_names: HashSet<&str> = base.labels.iter().map(String::as_str).collect();
    let base_labels = base
        .labels
        .iter()
        .map(|name| checkout.resolve_historical_label(name))
        .collect::<Result<BTreeSet<_>>>()?;
    let file_labels = file
        .labels
        .iter()
        .map(|name| {
            if base_names.contains(name.as_str()) {
                checkout.resolve_historical_label(name)
            } else {
                checkout.resolve_label(name)
            }
        })
        .collect::<Result<BTreeSet<_>>>()?;
    let labels_add = file_labels.difference(&base_labels).cloned().collect();
    let labels_remove = base_labels.difference(&file_labels).cloned().collect();
    Ok(TicketChanges {
        set: TicketSet {
            title: (file.title != base.title).then(|| file.title.clone()),
            status: (file.status != base.status).then_some(file.status),
            priority: (file.priority != base.priority).then_some(file.priority),
            assignee,
            body: (file.body != base.body).then(|| file.body.clone()),
            ..TicketSet::default()
        },
        labels_add,
        labels_remove,
    })
}

/// Diffs every mirror file against its base copy and pushes one update
/// mutation per dirty ticket.
fn push(checkout: &mut Checkout) -> Result<()> {
    let mut mutations = Vec::new();
    // The exact bytes each mutation was built from: after the push, a mirror
    // file may only be clobbered if it still matches (an edit saved while the
    // request was in flight is not on the server and must survive).
    let mut pushed = HashMap::new();

    let mut paths = Vec::new();
    for project_entry in fs::read_dir(checkout.host_dir())? {
        let project_entry = project_entry?;
        if !project_entry.file_type()?.is_dir() || project_entry.file_name() == ".flat" {
            continue;
        }
        for entry in fs::read_dir(project_entry.path())? {
            let path = entry?.path();
            if path.extension().and_then(|extension| extension.to_str()) == Some("md") {
                paths.push(path);
            }
        }
    }
    paths.sort();

    for path in paths {
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
        let changes = changed_ticket_set(checkout, &file, &base, &path)?;
        if changes.is_empty() {
            continue;
        }
        pushed.insert(stem.clone(), content);
        mutations.push(Mutation {
            mutation_id: Ulid::new().to_string(),
            op: MutationOp::Update,
            entity: Entity::Ticket,
            entity_id: ticket_state.id.clone(),
            base_seq: Some(ticket_state.seq),
            set: changes.set,
            owners_add: Vec::new(),
            owners_remove: Vec::new(),
            labels_add: changes.labels_add,
            labels_remove: changes.labels_remove,
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
    checkout.apply_projects(&response.project_deltas);
    checkout.apply_labels(&response.label_deltas);
    let skipped = checkout.apply_deltas(&response.deltas, &conflicted, &pushed)?;
    checkout.apply_tombstones(&response.tombstones)?;
    checkout.apply_project_tombstones(&response.project_tombstones)?;
    checkout.apply_label_tombstones(&response.label_tombstones);
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
/// how many were left untouched because that file could not be parsed or
/// merged; merges that wrote conflict markers are picked up by the caller's
/// marker scan.
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
        let comments = checkout.comments_for(&ticket.id);
        let merged = match merge::merge(
            &base,
            &local,
            ticket,
            &checkout.state.members,
            &checkout.state.labels,
            &checkout.state.label_history,
            &comments,
        ) {
            Ok(merged) => merged,
            Err(error) => {
                eprintln!(
                    "cannot merge {}: {error:#} (fix the file, or delete it to discard local edits)",
                    mirror.display()
                );
                unresolved += 1;
                continue;
            }
        };
        checkout.write_merged(ticket, &merged.content)?;
        if !merged.conflicted {
            println!("merged {} (kept local edits)", ticket.key);
        }
    }
    Ok(unresolved)
}

#[cfg(test)]
mod tests {
    use flat_schema::{
        Priority, SearchMatch, SearchMatchSource, SearchResult, Status, TicketTombstone,
    };

    use super::*;

    #[test]
    fn new_accepts_priority_and_assignee_flags() {
        let cli = Cli::try_parse_from([
            "flat",
            "new",
            "Title",
            "--project",
            "DEMO",
            "--priority",
            "urgent",
            "--assignee",
            "Gabe@Example.com",
            "--label",
            "bug",
        ])
        .unwrap();
        match cli.command {
            Command::New {
                title,
                project,
                priority,
                assignee,
                labels,
            } => {
                assert_eq!(title, "Title");
                assert_eq!(project, "DEMO");
                assert_eq!(priority, Some(Priority::Urgent));
                assert_eq!(assignee.as_deref(), Some("Gabe@Example.com"));
                assert_eq!(labels, ["bug"]);
            }
            _ => panic!("expected new command"),
        }
    }

    #[test]
    fn new_rejects_invalid_priority() {
        let error = Cli::try_parse_from([
            "flat",
            "new",
            "Title",
            "--project",
            "DEMO",
            "--priority",
            "critical",
        ])
        .err()
        .expect("invalid priority should fail parsing");
        assert!(error.to_string().contains("unknown priority"));
    }

    #[test]
    fn search_accepts_the_complete_server_request() {
        let cli = Cli::try_parse_from([
            "flat",
            "search",
            "oauth project:AUTH",
            "--sort",
            "updated",
            "--limit",
            "50",
            "--cursor",
            "cursor-token",
            "--json",
        ])
        .unwrap();
        assert!(matches!(
            cli.command,
            Command::Search {
                query,
                sort: Some(SearchSortArg::Updated),
                limit: Some(50),
                cursor: Some(cursor),
                json: true,
            } if query == "oauth project:AUTH" && cursor == "cursor-token"
        ));
    }

    #[test]
    fn search_human_output_is_compact_and_includes_the_next_cursor() {
        let response = SearchResponse {
            results: vec![SearchResult {
                key: "AUTH-142".into(),
                title: "Fix OAuth refresh".into(),
                project: "AUTH".into(),
                status: Status::InProgress,
                priority: Priority::High,
                assignee: Some("gabe@example.com".into()),
                created_at: "2026-08-24T18:04:11.000Z".into(),
                updated_at: "2026-08-26T09:22:41.000Z".into(),
                r#match: SearchMatch {
                    source: SearchMatchSource::Comment,
                    comment_id: Some("comment-1".into()),
                    excerpt: Some("...refresh lock\nis per-process...".into()),
                },
            }],
            next_cursor: Some("next-token".into()),
        };
        assert_eq!(
            format_search_response(&response),
            "AUTH-142  in_progress  high  gabe@example.com  Fix OAuth refresh\n  ...refresh lock is per-process...\nnext cursor: next-token\n"
        );
    }

    #[test]
    fn comment_requires_text_or_stdin() {
        let text = Cli::try_parse_from(["flat", "comment", "DEMO-1", "Markdown body"]).unwrap();
        assert!(matches!(
            text.command,
            Command::Comment {
                key,
                text: Some(body),
                stdin: false,
            } if key == "DEMO-1" && body == "Markdown body"
        ));

        let stdin = Cli::try_parse_from(["flat", "comment", "DEMO-1", "--stdin"]).unwrap();
        assert!(matches!(
            stdin.command,
            Command::Comment {
                text: None,
                stdin: true,
                ..
            }
        ));
        assert!(Cli::try_parse_from(["flat", "comment", "DEMO-1"]).is_err());
        assert!(Cli::try_parse_from(["flat", "comment", "DEMO-1", "body", "--stdin"]).is_err());
    }

    #[test]
    fn comment_requires_pending_mutations_to_sync_first() {
        let root = std::env::temp_dir().join(format!("flat-comment-pending-{}", Ulid::new()));
        let config = Config {
            server: "https://flat.example".into(),
            token: "test-token".into(),
        };
        let mut checkout = Checkout::initialize(&root, config).unwrap();
        checkout
            .write_pending(&Mutation {
                mutation_id: Ulid::new().to_string(),
                op: MutationOp::Create,
                entity: Entity::Comment,
                entity_id: Ulid::new().to_string(),
                base_seq: None,
                set: MutationSet {
                    ticket: Some("ticket-1".into()),
                    body: Some("original".into()),
                    ..MutationSet::default()
                },
                owners_add: Vec::new(),
                owners_remove: Vec::new(),
                labels_add: Vec::new(),
                labels_remove: Vec::new(),
            })
            .unwrap();

        let error = comment(&mut checkout, "DEMO-1", Some("retry".into()), false).unwrap_err();
        assert!(error.to_string().contains("run `flat sync`"));
        assert_eq!(checkout.pending_mutations().unwrap().len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    fn ticket(id: &str, key: &str, title: &str, seq: u32) -> Ticket {
        Ticket {
            id: id.to_string(),
            key: key.to_string(),
            project: "00000000000000000000000000".to_string(),
            title: title.to_string(),
            body: String::new(),
            status: Status::Todo,
            priority: Priority::None,
            assignee: None,
            labels: Vec::new(),
            created_at: "2026-08-25T12:34:56.000Z".to_string(),
            updated_at: "2026-08-25T12:34:56.000Z".to_string(),
            seq,
        }
    }

    #[test]
    fn delete_applies_unrelated_deltas_before_advancing_watermark() {
        let root = std::env::temp_dir().join(format!("flat-delete-{}", Ulid::new()));
        let config = Config {
            server: "https://flat.example".to_string(),
            token: "test-token".to_string(),
        };
        store::save_config(&root, &config).unwrap();
        let mut checkout = Checkout::open(&root).unwrap();
        let deleted = ticket("01JG4C2Q4V8XKZ3W5D9E7F2H6M", "DEMO-1", "Delete me", 1);
        let unrelated = ticket("01JG4C5E2MZYXWVTSRQPNMKJHG", "DEMO-2", "Before", 2);
        checkout
            .apply_deltas(
                &[deleted.clone(), unrelated.clone()],
                &HashSet::new(),
                &HashMap::new(),
            )
            .unwrap();
        checkout.state.last_seq = 2;
        checkout.save_state().unwrap();

        let updated = ticket(&unrelated.id, &unrelated.key, "After", 3);
        let response = SyncResponse {
            applied: Vec::new(),
            conflicts: Vec::new(),
            deltas: vec![updated.clone()],
            comment_deltas: Vec::new(),
            project_deltas: Vec::new(),
            label_deltas: Vec::new(),
            tombstones: vec![TicketTombstone {
                id: deleted.id.clone(),
                key: deleted.key.clone(),
                seq: 4,
            }],
            project_tombstones: Vec::new(),
            label_tombstones: Vec::new(),
            members: Vec::new(),
            latest_seq: 4,
        };

        assert!(apply_delete_changes(&mut checkout, &response)
            .unwrap()
            .is_empty());
        assert_eq!(checkout.state.last_seq, 4);
        assert!(!checkout.mirror_path(&deleted.key).exists());
        assert_eq!(
            fs::read_to_string(checkout.mirror_path(&updated.key)).unwrap(),
            markdown::render(
                &updated,
                &checkout.state.members,
                &checkout.state.labels,
                &[],
            )
            .unwrap()
        );

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn merge_skipped_continues_after_a_touched_comment_section() {
        let root = std::env::temp_dir().join(format!("flat-merge-comments-{}", Ulid::new()));
        let config = Config {
            server: "https://flat.example".into(),
            token: "test-token".into(),
        };
        let mut checkout = Checkout::initialize(&root, config).unwrap();
        let first = ticket("ticket-1", "DEMO-1", "First", 1);
        let second = ticket("ticket-2", "DEMO-2", "Second", 2);
        checkout
            .apply_deltas(
                &[first.clone(), second.clone()],
                &HashSet::new(),
                &HashMap::new(),
            )
            .unwrap();

        let first_path = checkout.mirror_path(&first.key);
        let mut first_local = fs::read_to_string(&first_path).unwrap();
        first_local.push_str("locally changed\n");
        fs::write(&first_path, &first_local).unwrap();
        let second_path = checkout.mirror_path(&second.key);
        let second_local = fs::read_to_string(&second_path)
            .unwrap()
            .replace("title: Second", "title: Local second");
        fs::write(&second_path, second_local).unwrap();

        let mut server_first = first;
        server_first.status = Status::Done;
        server_first.seq = 3;
        let mut server_second = second;
        server_second.status = Status::InProgress;
        server_second.seq = 4;
        let unresolved = merge_skipped(&mut checkout, &[server_first, server_second]).unwrap();

        assert_eq!(unresolved, 1);
        assert_eq!(fs::read_to_string(first_path).unwrap(), first_local);
        let merged_second = markdown::parse(&fs::read_to_string(second_path).unwrap()).unwrap();
        assert_eq!(merged_second.title, "Local second");
        assert_eq!(merged_second.status, Status::InProgress);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn clearing_assignment_emits_explicit_null() {
        let root = std::env::temp_dir().join(format!("flat-clear-{}", Ulid::new()));
        let config = Config {
            server: "https://flat.example".to_string(),
            token: "test-token".to_string(),
        };
        store::save_config(&root, &config).unwrap();
        let checkout = Checkout::open(&root).unwrap();
        let base = markdown::TicketFile {
            key: "DEMO-1".into(),
            project: "DEMO".into(),
            title: "Title".into(),
            status: Status::Todo,
            priority: Priority::None,
            assignee: Some("gabe@example.com".into()),
            labels: Vec::new(),
            created: Some("created".into()),
            updated: Some("updated".into()),
            body: String::new(),
            comments: format!("{}\n## Comments\n", markdown::COMMENT_SENTINEL),
        };
        let mut file = base.clone();
        file.assignee = None;
        let set = changed_ticket_set(&checkout, &file, &base, Path::new("DEMO-1.md")).unwrap();
        assert_eq!(set.set.assignee, Some(None));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn label_edits_emit_membership_deltas() {
        let root = std::env::temp_dir().join(format!("flat-label-deltas-{}", Ulid::new()));
        let config = Config {
            server: "https://flat.example".to_string(),
            token: "test-token".to_string(),
        };
        store::save_config(&root, &config).unwrap();
        let mut checkout = Checkout::open(&root).unwrap();
        checkout.apply_labels(&[
            Label {
                id: "label-auth".into(),
                name: "auth".into(),
                created_at: "created".into(),
                updated_at: "updated".into(),
                seq: 1,
            },
            Label {
                id: "label-bug".into(),
                name: "bug".into(),
                created_at: "created".into(),
                updated_at: "updated".into(),
                seq: 2,
            },
        ]);
        let base = markdown::TicketFile {
            key: "DEMO-1".into(),
            project: "DEMO".into(),
            title: "Title".into(),
            status: Status::Todo,
            priority: Priority::None,
            assignee: None,
            labels: vec!["auth".into()],
            created: Some("created".into()),
            updated: Some("updated".into()),
            body: String::new(),
            comments: format!("{}\n## Comments\n", markdown::COMMENT_SENTINEL),
        };
        let mut edited = base.clone();
        edited.labels = vec!["bug".into()];
        let changes =
            changed_ticket_set(&checkout, &edited, &base, Path::new("DEMO-1.md")).unwrap();
        assert_eq!(changes.labels_add, ["label-bug"]);
        assert_eq!(changes.labels_remove, ["label-auth"]);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn readonly_edits_are_rejected() {
        let root = std::env::temp_dir().join(format!("flat-readonly-{}", Ulid::new()));
        let config = Config {
            server: "https://flat.example".to_string(),
            token: "test-token".to_string(),
        };
        store::save_config(&root, &config).unwrap();
        let checkout = Checkout::open(&root).unwrap();
        let base = markdown::parse(
            "---\nid: DEMO-1\nproject: DEMO\ntitle: Title\nstatus: todo\nlabels: []\n---\n\n<!-- flat:comments -->\n## Comments\n",
        )
        .unwrap();
        let mut edited_title = base.clone();
        edited_title.title = "Edited".into();
        assert_eq!(
            changed_ticket_set(&checkout, &edited_title, &base, Path::new("DEMO-1.md"))
                .unwrap()
                .set,
            TicketSet {
                title: Some("Edited".into()),
                ..TicketSet::default()
            }
        );

        let mut edited = base.clone();
        edited.created = Some("changed".into());
        let error =
            changed_ticket_set(&checkout, &edited, &base, Path::new("DEMO-1.md")).unwrap_err();
        assert!(error.to_string().contains("created is read-only"));

        let mut edited = base.clone();
        edited.updated = Some("changed".into());
        let error =
            changed_ticket_set(&checkout, &edited, &base, Path::new("DEMO-1.md")).unwrap_err();
        assert!(error.to_string().contains("updated is read-only"));

        let mut edited = base.clone();
        edited.project = "AUTH".into();
        let error =
            changed_ticket_set(&checkout, &edited, &base, Path::new("DEMO-1.md")).unwrap_err();
        assert!(error.to_string().contains("project is read-only"));

        let mut edited = base.clone();
        edited.body = format!("before\n{}\nafter", markdown::COMMENT_SENTINEL);
        let error =
            changed_ticket_set(&checkout, &edited, &base, Path::new("DEMO-1.md")).unwrap_err();
        assert!(error
            .to_string()
            .contains("ticket body contains reserved comment sentinel"));

        let mut edited = base.clone();
        edited.comments.push_str("mangled\n");
        let error =
            changed_ticket_set(&checkout, &edited, &base, Path::new("DEMO-1.md")).unwrap_err();
        assert!(error.to_string().contains("comments are read-only"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
