//! Command implementations and the sync/push/merge core.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use flat_schema::{
    Conflict, Delta, EntityKind, Mutation, Op, Priority, Status, SyncRequest, Ticket,
    PROTOCOL_VERSION,
};
use serde_json::{json, Value};
use ulid::Ulid;

use crate::client::Client;
use crate::mirror;
use crate::state::State;
use crate::workspace::{flat_home, write_atomic, Config, Workspace};

fn read_opt(path: &Path) -> Result<Option<String>> {
    match fs::read_to_string(path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).with_context(|| format!("read {}", path.display())),
    }
}

fn project_key_of(state: &State, ticket: &Ticket) -> String {
    state
        .projects
        .get(&ticket.project_id)
        .map(|p| p.key.clone())
        // The key alias always embeds the project key (AUTH-142 -> AUTH).
        .unwrap_or_else(|| {
            ticket
                .key
                .rsplit_once('-')
                .map(|(p, _)| p.to_string())
                .unwrap_or_else(|| ticket.key.clone())
        })
}

fn new_mutation_id() -> String {
    Ulid::new().to_string()
}

// ---------------------------------------------------------------------------
// Mirror materialization
// ---------------------------------------------------------------------------

/// Brings mirror files up to date with the cached server state.
///
/// - clean files (byte-equal to their base copy, or brand new) are rewritten
///   to the current server render, and the base copy follows
/// - dirty files are left alone; if the server also changed the ticket,
///   `merge` folds the server changes in (git-style markers on overlap)
/// - ids in `overwrite` (tickets whose local edits were just applied by the
///   server) are force-rewritten to the canonical render
fn materialize(
    ws: &Workspace,
    state: &mut State,
    merge: bool,
    overwrite: &BTreeSet<String>,
) -> Result<()> {
    let tickets: Vec<Ticket> = state.tickets.values().cloned().collect();
    for ticket in tickets {
        let pkey = project_key_of(state, &ticket);
        let target = {
            let comments = state.comments_for(&ticket.id);
            mirror::render(&ticket, &pkey, &comments)
        };
        let fpath = ws.ticket_path(&pkey, &ticket.key);
        let bpath = ws.base_path(&ticket.key);
        let file = read_opt(&fpath)?;
        let base = read_opt(&bpath)?;

        let clean = file.is_none() || file == base;
        if clean || overwrite.contains(&ticket.id) {
            if file.as_deref() != Some(&target) {
                write_atomic(&fpath, &target)?;
            }
            if base.as_deref() != Some(&target) {
                write_atomic(&bpath, &target)?;
            }
            state.bases.insert(ticket.id.clone(), ticket.seq);
            continue;
        }

        // Dirty. Anything new from the server since our base?
        if state.bases.get(&ticket.id) == Some(&ticket.seq) {
            continue;
        }
        if merge {
            merge_ticket(ws, state, &ticket, &pkey, &target, base, file.unwrap())?;
        } else {
            eprintln!(
                "  {}: local edits + server changes; run `flat sync --merge`",
                ticket.key
            );
        }
    }
    Ok(())
}

fn apply_deltas(ws: &Workspace, state: &mut State, deltas: &[Delta]) -> Result<()> {
    for delta in deltas {
        if let Some(removed) = state.apply_delta(delta)? {
            let t = removed.ticket;
            let pkey = t
                .key
                .rsplit_once('-')
                .map(|(p, _)| p.to_string())
                .unwrap_or_else(|| t.key.clone());
            let fpath = ws.ticket_path(&pkey, &t.key);
            let bpath = ws.base_path(&t.key);
            let file = read_opt(&fpath)?;
            let base = read_opt(&bpath)?;
            if file.is_some() && file != base {
                eprintln!(
                    "  {}: deleted on server but locally modified; leaving {}",
                    t.key,
                    fpath.display()
                );
            } else {
                if file.is_some() {
                    fs::remove_file(&fpath)?;
                }
                if base.is_some() {
                    fs::remove_file(&bpath)?;
                }
                println!("  deleted {}", t.key);
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Merge (flat sync --merge)
// ---------------------------------------------------------------------------

fn merge_scalar(
    out: &mut String,
    conflicts: &mut Vec<&'static str>,
    name: &'static str,
    base: &str,
    local: &str,
    server: &str,
) {
    let value = if local == base {
        server // only the server changed it (or nobody did)
    } else if server == base || server == local {
        local // only we changed it; stays dirty and pushes later
    } else {
        conflicts.push(name);
        out.push_str(&format!(
            "<<<<<<< local\n{name}: {local}\n=======\n{name}: {server}\n>>>>>>> server\n"
        ));
        return;
    };
    out.push_str(&format!("{name}: {value}\n"));
}

fn merge_body(base: &str, local: &str, server: &str, conflicts: &mut Vec<&'static str>) -> String {
    if local == base {
        return server.to_string();
    }
    if server == base || server == local {
        return local.to_string();
    }
    let mut opts = diffy::MergeOptions::new();
    opts.set_conflict_style(diffy::ConflictStyle::Merge);
    match opts.merge(
        &format!("{base}\n"),
        &format!("{local}\n"),
        &format!("{server}\n"),
    ) {
        Ok(merged) => merged.trim_end().to_string(),
        Err(marked) => {
            conflicts.push("description");
            marked
                .replace("<<<<<<< ours", "<<<<<<< local")
                .replace(">>>>>>> theirs", ">>>>>>> server")
                .trim_end()
                .to_string()
        }
    }
}

/// Rewrites a dirty file to server state with unpushed local values folded
/// back in; overlapping edits become git-style conflict markers. The base
/// copy advances to the server render, so a later `flat push` sends exactly
/// the fields the user kept local.
fn merge_ticket(
    ws: &Workspace,
    state: &mut State,
    ticket: &Ticket,
    pkey: &str,
    server_render: &str,
    base_text: Option<String>,
    local_text: String,
) -> Result<()> {
    let Some(base_text) = base_text else {
        eprintln!(
            "  {}: no base copy; leaving local file (delete it and `flat sync` to restore)",
            ticket.key
        );
        return Ok(());
    };
    if mirror::has_conflict_markers(&local_text) {
        eprintln!(
            "  {}: still has unresolved conflict markers; resolve and `flat push`",
            ticket.key
        );
        return Ok(());
    }
    let base = mirror::parse(&base_text)
        .with_context(|| format!("corrupt base copy for {}", ticket.key))?;
    let local = match mirror::parse(&local_text) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("  {}: cannot parse local file ({e}); leaving as-is", ticket.key);
            return Ok(());
        }
    };

    let mut conflicts: Vec<&'static str> = Vec::new();
    let mut out = String::from("---\n");
    out.push_str(&format!("id: {}\n", ticket.key));
    merge_scalar(&mut out, &mut conflicts, "title", &base.title, &local.title, &ticket.title);
    merge_scalar(
        &mut out,
        &mut conflicts,
        "status",
        base.status.as_str(),
        local.status.as_str(),
        ticket.status.as_str(),
    );
    merge_scalar(
        &mut out,
        &mut conflicts,
        "priority",
        base.priority.as_str(),
        local.priority.as_str(),
        ticket.priority.as_str(),
    );
    merge_scalar(
        &mut out,
        &mut conflicts,
        "assignee",
        base.assignee.as_deref().unwrap_or("null"),
        local.assignee.as_deref().unwrap_or("null"),
        ticket.assignee.as_deref().unwrap_or("null"),
    );

    // Labels merge as sets: server state plus local adds minus local removes.
    let local_added: Vec<&String> = local.labels.iter().filter(|l| !base.labels.contains(l)).collect();
    let local_removed: Vec<&String> = base.labels.iter().filter(|l| !local.labels.contains(l)).collect();
    let mut merged_labels: Vec<String> = ticket
        .labels
        .iter()
        .filter(|l| !local_removed.contains(l))
        .cloned()
        .collect();
    for l in local_added {
        if !merged_labels.contains(l) {
            merged_labels.push(l.clone());
        }
    }
    out.push_str(&format!("labels: [{}]\n", merged_labels.join(", ")));
    out.push_str(&format!("project: {pkey}\n"));
    out.push_str(&format!("created: {}\n", ticket.created));
    out.push_str(&format!("updated: {}\n", ticket.updated));
    out.push_str("---\n\n");

    let body = merge_body(
        &base.body,
        &local.body,
        ticket.description.trim(),
        &mut conflicts,
    );
    if !body.trim().is_empty() {
        out.push_str(body.trim_end());
        out.push_str("\n\n");
    }
    {
        let comments = state.comments_for(&ticket.id);
        out.push_str(&mirror::render_comments(&comments));
    }

    write_atomic(&ws.ticket_path(pkey, &ticket.key), &out)?;
    write_atomic(&ws.base_path(&ticket.key), server_render)?;
    state.bases.insert(ticket.id.clone(), ticket.seq);

    if conflicts.is_empty() {
        println!("  merged {} cleanly (local edits kept; `flat push` to send)", ticket.key);
    } else {
        println!(
            "  merged {} with conflicts in: {} — edit the markers away, then `flat push`",
            ticket.key,
            conflicts.join(", ")
        );
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

/// Diffs a dirty working file against its base copy and builds the mutation.
/// Returns None when the difference is whitespace-only (no semantic change).
fn build_mutation(
    ticket: &Ticket,
    file_text: &str,
    base_text: &str,
    base_seq: u64,
) -> Result<Option<Mutation>> {
    if mirror::has_conflict_markers(file_text) {
        bail!("unresolved conflict markers; edit them away first");
    }
    let local = mirror::parse(file_text)?;
    let base = mirror::parse(base_text).context("corrupt base copy")?;

    if local.below_sentinel != base.below_sentinel {
        bail!("comments are read-only — use `flat comment {}`", ticket.key);
    }
    for (name, l, b) in [
        ("id", &local.id, &base.id),
        ("project", &local.project, &base.project),
        ("created", &local.created, &base.created),
        ("updated", &local.updated, &base.updated),
    ] {
        if l != b {
            bail!("{name} is read-only");
        }
    }

    let mut set: BTreeMap<String, Value> = BTreeMap::new();
    if local.title != base.title {
        set.insert("title".into(), json!(local.title));
    }
    if local.status != base.status {
        set.insert("status".into(), json!(local.status));
    }
    if local.priority != base.priority {
        set.insert("priority".into(), json!(local.priority));
    }
    if local.assignee != base.assignee {
        set.insert("assignee".into(), json!(local.assignee));
    }
    if local.body != base.body {
        set.insert("description".into(), json!(local.body));
    }
    let labels_add: Vec<String> = local
        .labels
        .iter()
        .filter(|l| !base.labels.contains(l))
        .cloned()
        .collect();
    let labels_remove: Vec<String> = base
        .labels
        .iter()
        .filter(|l| !local.labels.contains(l))
        .cloned()
        .collect();

    if set.is_empty() && labels_add.is_empty() && labels_remove.is_empty() {
        return Ok(None);
    }
    Ok(Some(Mutation {
        mutation_id: new_mutation_id(),
        op: Op::Update,
        entity: EntityKind::Ticket,
        entity_id: ticket.id.clone(),
        base_seq,
        set,
        labels_add,
        labels_remove,
    }))
}

pub fn push(keys: Vec<String>, force: bool) -> Result<()> {
    let ws = Workspace::open()?;
    let mut state = ws.load_state()?;
    let client = Client::new(&ws.config.server, &ws.config.token);

    let selected: Option<BTreeSet<String>> = if keys.is_empty() {
        None
    } else {
        for k in &keys {
            state.ticket_by_key(k)?;
        }
        Some(keys.into_iter().collect())
    };

    let mut mutations: Vec<Mutation> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    let tickets: Vec<Ticket> = state.tickets.values().cloned().collect();
    for ticket in &tickets {
        if let Some(sel) = &selected {
            if !sel.contains(&ticket.key) {
                continue;
            }
        }
        let pkey = project_key_of(&state, ticket);
        let fpath = ws.ticket_path(&pkey, &ticket.key);
        let (Some(file), Some(base)) = (read_opt(&fpath)?, read_opt(&ws.base_path(&ticket.key))?)
        else {
            continue;
        };
        if file == base {
            continue;
        }
        let base_seq = state.bases.get(&ticket.id).copied().unwrap_or(0);
        match build_mutation(ticket, &file, &base, base_seq) {
            Ok(Some(m)) => mutations.push(m),
            Ok(None) => write_atomic(&fpath, &base)?, // whitespace-only: re-canonicalize
            Err(e) => errors.push(format!("{}: {e:#}", ticket.key)),
        }
    }

    for e in &errors {
        eprintln!("error: {e}");
    }
    if mutations.is_empty() {
        println!("nothing to push");
        if !errors.is_empty() {
            bail!("push incomplete");
        }
        return Ok(());
    }

    let mut applied = Vec::new();
    let mut rejected = Vec::new();
    let mut conflicts: Vec<Conflict>;
    let mut pending = mutations;
    let mut retries = 0;
    loop {
        let resp = client.sync(&SyncRequest {
            protocol_version: PROTOCOL_VERSION,
            last_seq: state.last_seq,
            mutations: pending.clone(),
        })?;
        apply_deltas(&ws, &mut state, &resp.deltas)?;
        if resp.latest_seq > state.last_seq {
            state.last_seq = resp.latest_seq;
        }
        applied.extend(resp.applied);
        rejected.extend(resp.rejected);
        conflicts = resp.conflicts;
        if force && !conflicts.is_empty() && retries < 3 {
            retries += 1;
            let latest = resp.latest_seq;
            pending = conflicts
                .iter()
                .filter_map(|c| pending.iter().find(|m| m.mutation_id == c.mutation_id))
                .cloned()
                .map(|mut m| {
                    m.base_seq = latest;
                    m
                })
                .collect();
            continue;
        }
        break;
    }

    let overwrite: BTreeSet<String> = applied.iter().map(|a| a.entity_id.clone()).collect();
    materialize(&ws, &mut state, false, &overwrite)?;
    ws.save_state(&state)?;

    let key_of = |id: &str| {
        state
            .tickets
            .get(id)
            .map(|t| t.key.clone())
            .unwrap_or_else(|| id.to_string())
    };
    for a in &applied {
        println!("pushed {} (seq {})", key_of(&a.entity_id), a.seq);
    }
    for c in &conflicts {
        println!(
            "conflict {}: [{}] changed on the server too; run `flat sync --merge` (or `flat push --force`)",
            key_of(&c.entity_id),
            c.fields.join(", ")
        );
    }
    for r in &rejected {
        println!("rejected {}: {}", key_of(&r.entity_id), r.error);
    }
    if !conflicts.is_empty() || !rejected.is_empty() || !errors.is_empty() {
        bail!("push incomplete");
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

pub fn sync(merge: bool) -> Result<()> {
    let ws = Workspace::open()?;
    let mut state = ws.load_state()?;
    let client = Client::new(&ws.config.server, &ws.config.token);
    let resp = client.sync(&SyncRequest {
        protocol_version: PROTOCOL_VERSION,
        last_seq: state.last_seq,
        mutations: vec![],
    })?;
    let fetched = resp.deltas.len();
    apply_deltas(&ws, &mut state, &resp.deltas)?;
    if resp.latest_seq > state.last_seq {
        state.last_seq = resp.latest_seq;
    }
    materialize(&ws, &mut state, merge, &BTreeSet::new())?;
    ws.save_state(&state)?;
    println!("synced to seq {} ({} deltas)", state.last_seq, fetched);
    Ok(())
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

fn host_dir(server: &str) -> String {
    let no_scheme = server.split("://").last().unwrap_or(server);
    let host = no_scheme.split('/').next().unwrap_or(no_scheme);
    host.replace(':', "-")
}

fn git_email() -> String {
    std::process::Command::new("git")
        .args(["config", "--get", "user.email"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

pub fn init(server: String, token: String, dir: Option<PathBuf>) -> Result<()> {
    let root = match dir {
        Some(d) => d,
        None => flat_home()?.join(host_dir(&server)),
    };
    let config = Config {
        server,
        token,
        email: git_email(),
    };
    let ws = Workspace::create(root, config)?;
    let client = Client::new(&ws.config.server, &ws.config.token);
    let snap = client.snapshot()?;
    let mut state = State::from_snapshot(snap);
    materialize(&ws, &mut state, false, &BTreeSet::new())?;
    ws.save_state(&state)?;
    println!("initialized mirror at {}", ws.root.display());
    println!(
        "  {} project(s), {} ticket(s), synced to seq {}",
        state.projects.len(),
        state.tickets.len(),
        state.last_seq
    );
    if std::env::var_os("FLAT_DIR").is_none() {
        println!("  (set FLAT_DIR={} if you use multiple mirrors)", ws.root.display());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// New / comment
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
pub fn new_ticket(
    title: String,
    project: String,
    assignee: Option<String>,
    priority: Option<Priority>,
    status: Option<Status>,
    labels: Vec<String>,
    body: Option<String>,
) -> Result<()> {
    let ws = Workspace::open()?;
    let mut state = ws.load_state()?;
    let client = Client::new(&ws.config.server, &ws.config.token);

    // Freshen first so the project list and counters are current.
    let resp = client.sync(&SyncRequest {
        protocol_version: PROTOCOL_VERSION,
        last_seq: state.last_seq,
        mutations: vec![],
    })?;
    apply_deltas(&ws, &mut state, &resp.deltas)?;
    if resp.latest_seq > state.last_seq {
        state.last_seq = resp.latest_seq;
    }

    let project_id = state.project_by_key(&project)?.id.clone();
    let mut set: BTreeMap<String, Value> = BTreeMap::new();
    set.insert("project_id".into(), json!(project_id));
    set.insert("title".into(), json!(title));
    if let Some(a) = assignee {
        let a = if a == "me" { ws.config.email.clone() } else { a };
        if a.is_empty() {
            bail!("--assignee me requires `git config user.email` (or pass an email)");
        }
        set.insert("assignee".into(), json!(a));
    }
    if let Some(p) = priority {
        set.insert("priority".into(), json!(p));
    }
    if let Some(s) = status {
        set.insert("status".into(), json!(s));
    }
    if let Some(b) = body {
        set.insert("description".into(), json!(b));
    }

    let ticket_id = Ulid::new().to_string();
    let resp = client.sync(&SyncRequest {
        protocol_version: PROTOCOL_VERSION,
        last_seq: state.last_seq,
        mutations: vec![Mutation {
            mutation_id: new_mutation_id(),
            op: Op::Create,
            entity: EntityKind::Ticket,
            entity_id: ticket_id.clone(),
            base_seq: state.last_seq,
            set,
            labels_add: labels,
            labels_remove: vec![],
        }],
    })?;
    if let Some(r) = resp.rejected.first() {
        bail!("server rejected the ticket: {}", r.error);
    }
    apply_deltas(&ws, &mut state, &resp.deltas)?;
    if resp.latest_seq > state.last_seq {
        state.last_seq = resp.latest_seq;
    }
    let overwrite: BTreeSet<String> = [ticket_id.clone()].into();
    materialize(&ws, &mut state, false, &overwrite)?;
    ws.save_state(&state)?;

    let ticket = state
        .tickets
        .get(&ticket_id)
        .context("server applied the create but returned no ticket delta")?;
    let pkey = project_key_of(&state, ticket);
    println!("created {}", ticket.key);
    println!("  {}", ws.ticket_path(&pkey, &ticket.key).display());
    Ok(())
}

pub fn comment(key: String, text: Option<String>, use_stdin: bool) -> Result<()> {
    let body = match (text, use_stdin) {
        (Some(t), false) => t,
        (None, _) | (_, true) => {
            let mut buf = String::new();
            std::io::stdin().read_to_string(&mut buf)?;
            buf.trim().to_string()
        }
    };
    if body.is_empty() {
        bail!("empty comment");
    }

    let ws = Workspace::open()?;
    let mut state = ws.load_state()?;
    if ws.config.email.is_empty() {
        bail!(
            "no identity: set `git config user.email` and update {}",
            ws.config_path().display()
        );
    }
    let client = Client::new(&ws.config.server, &ws.config.token);
    let ticket_id = state.ticket_by_key(&key)?.id.clone();

    let mut set: BTreeMap<String, Value> = BTreeMap::new();
    set.insert("ticket_id".into(), json!(ticket_id));
    set.insert("body".into(), json!(body));
    set.insert("author".into(), json!(ws.config.email));
    let resp = client.sync(&SyncRequest {
        protocol_version: PROTOCOL_VERSION,
        last_seq: state.last_seq,
        mutations: vec![Mutation {
            mutation_id: new_mutation_id(),
            op: Op::Create,
            entity: EntityKind::Comment,
            entity_id: Ulid::new().to_string(),
            base_seq: state.last_seq,
            set,
            labels_add: vec![],
            labels_remove: vec![],
        }],
    })?;
    if let Some(r) = resp.rejected.first() {
        bail!("server rejected the comment: {}", r.error);
    }
    apply_deltas(&ws, &mut state, &resp.deltas)?;
    if resp.latest_seq > state.last_seq {
        state.last_seq = resp.latest_seq;
    }
    materialize(&ws, &mut state, false, &BTreeSet::new())?;
    ws.save_state(&state)?;
    println!("commented on {key}");
    Ok(())
}

// ---------------------------------------------------------------------------
// Listings / admin
// ---------------------------------------------------------------------------

pub fn ls(project: Option<String>) -> Result<()> {
    let ws = Workspace::open()?;
    let state = ws.load_state()?;
    let filter_id = match &project {
        Some(key) => Some(state.project_by_key(key)?.id.clone()),
        None => None,
    };
    let mut tickets: Vec<&Ticket> = state
        .tickets
        .values()
        .filter(|t| filter_id.as_deref().map_or(true, |id| t.project_id == id))
        .collect();
    tickets.sort_by(|a, b| a.key.cmp(&b.key));
    for t in tickets {
        println!(
            "{:<10} {:<12} {:<8} {:<24} {}",
            t.key,
            t.status.as_str(),
            t.priority.as_str(),
            t.assignee.as_deref().unwrap_or("-"),
            t.title
        );
    }
    Ok(())
}

pub fn path() -> Result<()> {
    println!("{}", Workspace::open()?.root.display());
    Ok(())
}

pub fn project_add(key: String, name: String, owners: Vec<String>) -> Result<()> {
    let ws = Workspace::open()?;
    let mut state = ws.load_state()?;
    let client = Client::new(&ws.config.server, &ws.config.token);
    let mut set: BTreeMap<String, Value> = BTreeMap::new();
    set.insert("key".into(), json!(key));
    set.insert("name".into(), json!(name));
    set.insert("owners".into(), json!(owners));
    let resp = client.sync(&SyncRequest {
        protocol_version: PROTOCOL_VERSION,
        last_seq: state.last_seq,
        mutations: vec![Mutation {
            mutation_id: new_mutation_id(),
            op: Op::Create,
            entity: EntityKind::Project,
            entity_id: Ulid::new().to_string(),
            base_seq: state.last_seq,
            set,
            labels_add: vec![],
            labels_remove: vec![],
        }],
    })?;
    if let Some(r) = resp.rejected.first() {
        bail!("server rejected the project: {}", r.error);
    }
    apply_deltas(&ws, &mut state, &resp.deltas)?;
    if resp.latest_seq > state.last_seq {
        state.last_seq = resp.latest_seq;
    }
    ws.save_state(&state)?;
    println!("created project {key}");
    Ok(())
}

pub fn project_ls() -> Result<()> {
    let ws = Workspace::open()?;
    let state = ws.load_state()?;
    for p in state.projects.values() {
        println!("{:<10} {}", p.key, p.name);
    }
    Ok(())
}
