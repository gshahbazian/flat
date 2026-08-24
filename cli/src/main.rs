//! `flat`: filesystem-first ticket CLI. See TICKET_SYSTEM.md at the repo
//! root for the design.

mod client;
mod commands;
mod mirror;
mod state;
mod workspace;

use std::path::PathBuf;

use clap::{Parser, Subcommand};
use flat_schema::{Priority, Status};

#[derive(Parser)]
#[command(name = "flat", version, about = "tickets as files, for agents and humans")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Connect to a tenant, write config, and take the first snapshot
    Init {
        /// Server URL, e.g. https://flat.acme.workers.dev
        #[arg(long)]
        server: String,
        /// Bearer API token
        #[arg(long)]
        token: String,
        /// Mirror directory (default: ~/.flat/<tenant-host>)
        #[arg(long)]
        dir: Option<PathBuf>,
    },
    /// Pull server changes into the mirror
    Sync {
        /// Fold server changes into locally edited files; overlapping edits
        /// get git-style conflict markers
        #[arg(long)]
        merge: bool,
    },
    /// Push locally edited files (default: all dirty files)
    Push {
        /// Ticket keys to push, e.g. AUTH-142
        keys: Vec<String>,
        /// Skip conflict checks and apply local values
        #[arg(long)]
        force: bool,
    },
    /// Create a ticket
    New {
        title: String,
        /// Project key, e.g. AUTH
        #[arg(long)]
        project: String,
        /// Assignee email, or `me`
        #[arg(long)]
        assignee: Option<String>,
        #[arg(long)]
        priority: Option<Priority>,
        #[arg(long)]
        status: Option<Status>,
        /// May be repeated
        #[arg(long = "label")]
        labels: Vec<String>,
        /// Description body
        #[arg(long, short = 'm')]
        body: Option<String>,
    },
    /// Add a comment to a ticket
    Comment {
        key: String,
        text: Option<String>,
        /// Read the comment body from stdin
        #[arg(long)]
        stdin: bool,
    },
    /// List tickets from the local cache
    Ls {
        /// Filter by project key
        #[arg(long)]
        project: Option<String>,
    },
    /// Print the mirror location
    Path,
    /// Project administration
    Project {
        #[command(subcommand)]
        cmd: ProjectCmd,
    },
}

#[derive(Subcommand)]
enum ProjectCmd {
    /// Create a project
    Add {
        /// Project key: ^[A-Z][A-Z0-9]{1,7}$, immutable
        key: String,
        #[arg(long)]
        name: String,
        /// Owner emails; may be repeated
        #[arg(long = "owner")]
        owners: Vec<String>,
    },
    /// List projects
    Ls,
}

fn main() {
    let cli = Cli::parse();
    let result = match cli.cmd {
        Cmd::Init { server, token, dir } => commands::init(server, token, dir),
        Cmd::Sync { merge } => commands::sync(merge),
        Cmd::Push { keys, force } => commands::push(keys, force),
        Cmd::New {
            title,
            project,
            assignee,
            priority,
            status,
            labels,
            body,
        } => commands::new_ticket(title, project, assignee, priority, status, labels, body),
        Cmd::Comment { key, text, stdin } => commands::comment(key, text, stdin),
        Cmd::Ls { project } => commands::ls(project),
        Cmd::Path => commands::path(),
        Cmd::Project { cmd } => match cmd {
            ProjectCmd::Add { key, name, owners } => commands::project_add(key, name, owners),
            ProjectCmd::Ls => commands::project_ls(),
        },
    };
    if let Err(e) = result {
        eprintln!("error: {e:#}");
        std::process::exit(1);
    }
}
