//! The out-of-repo mirror: `~/.flat/<host>/<PROJECT>/<PROJECT-N>.md` plus base copies
//! and sync state under `~/.flat/<host>/.flat/`. `FLAT_DIR` overrides the
//! root, which also makes a second checkout trivial.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use flat_schema::{MemberProfile, Mutation, Project, ProjectTombstone, Ticket, TicketTombstone};
use serde::{Deserialize, Serialize};

use crate::markdown;
use crate::merge;

#[derive(Debug, Serialize, Deserialize)]
pub struct Config {
    pub server: String,
    pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TicketState {
    /// The ticket's ULID; files and humans only ever see the key.
    pub id: String,
    /// Immutable project ULID.
    #[serde(default)]
    pub project: String,
    /// Seq of the server state our base copy reflects; travels as base_seq.
    pub seq: u32,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct State {
    pub last_seq: u32,
    /// Ticket key -> local sync state.
    pub tickets: BTreeMap<String, TicketState>,
    /// Project key -> current synced project row.
    #[serde(default)]
    pub projects: BTreeMap<String, Project>,
    /// Member ULID -> safe profile used to render and resolve assignees.
    #[serde(default)]
    pub members: BTreeMap<String, MemberProfile>,
}

pub fn flat_root() -> Result<PathBuf> {
    if let Some(dir) = std::env::var_os("FLAT_DIR") {
        return Ok(PathBuf::from(dir));
    }
    let home = std::env::home_dir().context("cannot determine home directory (set FLAT_DIR)")?;
    Ok(home.join(".flat"))
}

fn config_path(root: &Path) -> PathBuf {
    root.join("config.json")
}

pub fn save_config(root: &Path, config: &Config) -> Result<()> {
    ensure_private_dir(root)?;
    // 0600: the config holds the bearer token.
    write_atomic_mode(
        &config_path(root),
        &format!("{}\n", serde_json::to_string_pretty(config)?),
        Some(0o600),
    )
}

/// Validates and prepares every directory init will need before a one-time
/// enrollment credential is redeemed remotely.
pub fn preflight_init(root: &Path, server: &str) -> Result<()> {
    let host_dir = root.join(host_dir_name(server)?);
    let metadata_dir = host_dir.join(".flat");
    ensure_private_dir(root)?;
    ensure_private_dir(&host_dir)?;
    ensure_private_dir(&metadata_dir)?;
    verify_writable(root)?;
    verify_writable(&host_dir)?;
    verify_writable(&metadata_dir)
}

pub fn load_config(root: &Path) -> Result<Config> {
    let path = config_path(root);
    let raw = fs::read_to_string(&path)
        .with_context(|| format!("no checkout at {} — run `flat init` first", path.display()))?;
    serde_json::from_str(&raw).with_context(|| format!("malformed {}", path.display()))
}

/// One initialized mirror: the directory tree for a single server host.
pub struct Checkout {
    pub config: Config,
    pub state: State,
    host_dir: PathBuf,
}

impl Checkout {
    pub fn open(root: &Path) -> Result<Checkout> {
        let config = load_config(root)?;
        let host_dir = root.join(host_dir_name(&config.server)?);
        // Tickets can hold private company data: keep the whole tree 0700 so
        // umask never exposes it. Two choke points cover every file below.
        ensure_private_dir(root)?;
        ensure_private_dir(&host_dir)?;
        let state_path = host_dir.join(".flat").join("state.json");
        let state = match fs::read_to_string(&state_path) {
            Ok(raw) => serde_json::from_str(&raw)
                .with_context(|| format!("malformed {}", state_path.display()))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => State::default(),
            Err(e) => return Err(e).context(format!("reading {}", state_path.display())),
        };
        Ok(Checkout {
            config,
            state,
            host_dir,
        })
    }

    /// Creates an empty checkout for snapshot initialization without parsing
    /// stale state that the authoritative snapshot is about to replace.
    pub fn initialize(root: &Path, config: Config) -> Result<Checkout> {
        let host_dir = root.join(host_dir_name(&config.server)?);
        ensure_private_dir(root)?;
        ensure_private_dir(&host_dir)?;
        Ok(Checkout {
            config,
            state: State::default(),
            host_dir,
        })
    }

    pub fn host_dir(&self) -> &Path {
        &self.host_dir
    }

    pub fn project_dir(&self, project_key: &str) -> PathBuf {
        self.host_dir.join(project_key)
    }

    pub fn mirror_path(&self, key: &str) -> PathBuf {
        let project_key = key.rsplit_once('-').map_or(key, |(project, _)| project);
        self.project_dir(project_key).join(format!("{key}.md"))
    }

    pub fn base_path(&self, key: &str) -> PathBuf {
        self.host_dir
            .join(".flat")
            .join("base")
            .join(format!("{key}.md"))
    }

    fn pending_dir(&self) -> PathBuf {
        self.host_dir.join(".flat").join("pending")
    }

    /// Mutations journaled before sending and not yet acknowledged. Replaying
    /// them is free: the server's applied_mutations table returns the original
    /// result for a mutation_id it has already seen.
    pub fn pending_mutations(&self) -> Result<Vec<Mutation>> {
        let dir = self.pending_dir();
        let mut paths: Vec<PathBuf> = match fs::read_dir(&dir) {
            Ok(entries) => entries
                .map(|e| e.map(|e| e.path()))
                .collect::<std::io::Result<_>>()?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e).context(format!("reading {}", dir.display())),
        };
        paths.retain(|p| p.extension().and_then(|e| e.to_str()) == Some("json"));
        paths.sort(); // filenames are mutation ULIDs: lexicographic = chronological
        let mut mutations = Vec::new();
        for path in paths {
            let raw = fs::read_to_string(&path)?;
            mutations.push(
                serde_json::from_str(&raw)
                    .with_context(|| format!("malformed {}", path.display()))?,
            );
        }
        Ok(mutations)
    }

    pub fn write_pending(&self, mutation: &Mutation) -> Result<()> {
        let dir = self.pending_dir();
        fs::create_dir_all(&dir)?;
        write_atomic(
            &dir.join(format!("{}.json", mutation.mutation_id)),
            &format!("{}\n", serde_json::to_string_pretty(mutation)?),
        )
    }

    pub fn clear_pending(&self, mutation_id: &str) -> Result<()> {
        match fs::remove_file(self.pending_dir().join(format!("{mutation_id}.json"))) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e).context(format!("clearing pending mutation {mutation_id}")),
        }
    }

    /// Wipes local state so a snapshot can be applied as authoritative:
    /// rerunning `flat init` reconciles (tickets absent from the new snapshot
    /// disappear) instead of layering deltas over a stale mirror.
    pub fn reset(&mut self) -> Result<()> {
        let mut directories = vec![self.host_dir.join(".flat").join("base"), self.pending_dir()];
        for entry in fs::read_dir(&self.host_dir)? {
            let entry = entry?;
            if entry.file_type()?.is_dir()
                && entry.file_name() != ".flat"
                && entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| flat_schema::validate_project_key(name).is_ok())
            {
                directories.push(entry.path());
            }
        }
        for dir in directories {
            match fs::remove_dir_all(&dir) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e).context(format!("clearing {}", dir.display())),
            }
        }
        self.state = State::default();
        Ok(())
    }

    pub fn save_state(&self) -> Result<()> {
        let path = self.host_dir.join(".flat").join("state.json");
        fs::create_dir_all(path.parent().unwrap())?;
        write_atomic(
            &path,
            &format!("{}\n", serde_json::to_string_pretty(&self.state)?),
        )
    }

    /// Sync responses carry the full safe profile list. Replace it before
    /// rendering any ticket delta so assignment IDs always have names.
    pub fn update_members(&mut self, members: &[MemberProfile]) {
        self.state.members = members
            .iter()
            .cloned()
            .map(|member| (member.id.clone(), member))
            .collect();
    }

    pub fn apply_projects(&mut self, projects: &[Project]) {
        for project in projects {
            self.state
                .projects
                .insert(project.key.clone(), project.clone());
        }
    }

    pub fn project(&self, key: &str) -> Result<&Project> {
        self.state
            .projects
            .get(key)
            .with_context(|| format!("unknown project {key:?}; run `flat sync`"))
    }

    pub fn resolve_member(&self, email: &str) -> Result<String> {
        let normalized = flat_schema::normalize_email(email).map_err(anyhow::Error::msg)?;
        self.state
            .members
            .values()
            .find(|member| member.email == normalized)
            .map(|member| member.id.clone())
            .with_context(|| {
                format!("unknown member {normalized:?} in the local cache; run `flat sync`")
            })
    }

    pub fn resolve_assignee(&self, email: &str) -> Result<String> {
        let normalized = flat_schema::normalize_email(email).map_err(anyhow::Error::msg)?;
        self.state
            .members
            .values()
            .find(|member| member.email == normalized)
            .map(|member| member.id.clone())
            .with_context(|| {
                format!(
                    "unknown assignee {normalized:?} in the local member cache; run `flat sync`"
                )
            })
    }

    /// Materializes server deltas into the mirror and base copies.
    ///
    /// A file with unpushed local edits is never clobbered here: a delta only
    /// lands when the mirror file is provably clean — missing, already at
    /// server state, equal to its base copy, or byte-identical to the content
    /// in `pushed` (push: the exact bytes each mutation was built from, so an
    /// edit saved mid-flight is preserved). Tickets in `keep_local` are
    /// skipped entirely (push: a conflicted ticket keeps its local edits).
    /// Everything else — including a dirty file whose base copy is missing or
    /// unreadable, which proves nothing — is left in place and returned to
    /// the caller, who reports it (or three-way merges it, `flat sync
    /// --merge`) and holds back last_seq so a later sync re-delivers the
    /// withheld delta.
    pub fn apply_deltas(
        &mut self,
        deltas: &[Ticket],
        keep_local: &HashSet<String>,
        pushed: &HashMap<String, String>,
    ) -> Result<Vec<Ticket>> {
        let mut skipped = Vec::new();
        for ticket in deltas {
            if keep_local.contains(&ticket.key) {
                continue;
            }
            let rendered = markdown::render(ticket, &self.state.members)?;
            let clean = match fs::read_to_string(self.mirror_path(&ticket.key)) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
                Err(e) => return Err(e).context(format!("reading mirror file of {}", ticket.key)),
                Ok(current) => {
                    current == rendered
                        || pushed.get(&ticket.key) == Some(&current)
                        || fs::read_to_string(self.base_path(&ticket.key))
                            .is_ok_and(|base| base == current)
                }
            };
            if !clean {
                skipped.push(ticket.clone());
                continue;
            }
            self.write_ticket(ticket, &rendered, &rendered)?;
        }
        Ok(skipped)
    }

    /// Applies authoritative server deletions to the mirror, base copy, and
    /// sync state so a later restore cannot resurrect the ticket.
    pub fn apply_tombstones(&mut self, tombstones: &[TicketTombstone]) -> Result<()> {
        for tombstone in tombstones {
            for path in [
                self.mirror_path(&tombstone.key),
                self.base_path(&tombstone.key),
            ] {
                match fs::remove_file(&path) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => {
                        return Err(error).with_context(|| format!("removing {}", path.display()))
                    }
                }
            }
            self.state.tickets.remove(&tombstone.key);
        }
        Ok(())
    }

    pub fn apply_project_tombstones(&mut self, tombstones: &[ProjectTombstone]) -> Result<()> {
        for tombstone in tombstones {
            self.state.projects.remove(&tombstone.key);
            match fs::remove_dir(self.project_dir(&tombstone.key)) {
                Ok(()) => {}
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
                    ) => {}
                Err(error) => return Err(error).context("removing deleted project directory"),
            }
        }
        Ok(())
    }

    /// Writes the outcome of a three-way merge: the merged content (possibly
    /// holding conflict markers) becomes the mirror file, while the base copy
    /// and state advance to the server row — so the next `flat push` sends
    /// exactly the local side of the merge with a fresh base_seq.
    pub fn write_merged(&mut self, ticket: &Ticket, merged: &str) -> Result<()> {
        let base = markdown::render(ticket, &self.state.members)?;
        self.write_ticket(ticket, merged, &base)
    }

    fn write_ticket(&mut self, ticket: &Ticket, mirror: &str, base: &str) -> Result<()> {
        let mirror_path = self.mirror_path(&ticket.key);
        let base_path = self.base_path(&ticket.key);
        fs::create_dir_all(mirror_path.parent().unwrap())?;
        fs::create_dir_all(base_path.parent().unwrap())?;
        write_atomic(&mirror_path, mirror)?;
        write_atomic(&base_path, base)?;
        self.state.tickets.insert(
            ticket.key.clone(),
            TicketState {
                id: ticket.id.clone(),
                project: ticket.project.clone(),
                seq: ticket.seq,
            },
        );
        Ok(())
    }

    /// Mirror files still containing conflict markers, from any past merge.
    /// Derived by scanning rather than persisted state, so resolving (or
    /// deleting) a file clears it with nothing to invalidate.
    pub fn marker_files(&self) -> Result<Vec<PathBuf>> {
        let mut found = Vec::new();
        for key in self.state.tickets.keys() {
            let path = self.mirror_path(key);
            match fs::read_to_string(&path) {
                Ok(content) if merge::has_markers(&content) => found.push(path),
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e).context(format!("reading {}", path.display())),
            }
        }
        Ok(found)
    }

    /// Re-materializes mirror files that were deleted locally from their base
    /// copies (the last synced server state). Deleting a file is how local
    /// edits are discarded, now that sync never overwrites them.
    pub fn restore_missing(&self) -> Result<Vec<String>> {
        let mut restored = Vec::new();
        for key in self.state.tickets.keys() {
            let mirror = self.mirror_path(key);
            if mirror.exists() {
                continue;
            }
            let base = match fs::read_to_string(self.base_path(key)) {
                Ok(base) => base,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e).context(format!("reading base copy of {key}")),
            };
            fs::create_dir_all(mirror.parent().unwrap())?;
            write_atomic(&mirror, &base)?;
            restored.push(key.clone());
        }
        Ok(restored)
    }
}

pub fn host_dir_name(server: &str) -> Result<String> {
    let url = url::Url::parse(server).with_context(|| format!("invalid server url {server:?}"))?;
    let host = url
        .host_str()
        .with_context(|| format!("server url {server:?} has no host"))?;
    Ok(match url.port() {
        Some(port) => format!("{host}-{port}"),
        None => host.to_string(),
    })
}

fn write_atomic(path: &Path, content: &str) -> Result<()> {
    write_atomic_mode(path, content, None)
}

fn write_atomic_mode(path: &Path, content: &str, mode: Option<u32>) -> Result<()> {
    // Append .tmp to the whole name (DEMO-1.md.tmp): `with_extension` would
    // produce DEMO-1.tmp, and a crashed write would leave what looks like a
    // ticket file in the mirror.
    let mut name = path
        .file_name()
        .context("path has no file name")?
        .to_os_string();
    name.push(".tmp");
    let tmp = path.with_file_name(name);
    // Recreate the tmp so `mode` applies from the first byte written — a
    // chmod after the fact would leave the content readable in the interim.
    let _ = fs::remove_file(&tmp);
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    if let Some(mode) = mode {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
    {
        use std::io::Write;
        let mut file = options
            .open(&tmp)
            .with_context(|| format!("creating {}", tmp.display()))?;
        file.write_all(content.as_bytes())
            .with_context(|| format!("writing {}", tmp.display()))?;
    }
    fs::rename(&tmp, path).with_context(|| format!("writing {}", path.display()))
}

fn ensure_private_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path).with_context(|| format!("creating {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .with_context(|| format!("setting permissions on {}", path.display()))?;
    }
    Ok(())
}

fn verify_writable(path: &Path) -> Result<()> {
    let probe = path.join(format!(".flat-init-{}.tmp", ulid::Ulid::new()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(&probe)
        .with_context(|| format!("checking write access to {}", path.display()))?;
    fs::remove_file(&probe)
        .with_context(|| format!("cleaning up write check in {}", path.display()))
}

#[cfg(test)]
mod tests {
    use flat_schema::{Priority, Project, ProjectTombstone, Status, TicketTombstone};

    use super::*;

    fn checkout(name: &str) -> Checkout {
        let host_dir =
            std::env::temp_dir().join(format!("flat-store-{name}-{}", ulid::Ulid::new()));
        Checkout {
            config: Config {
                server: "https://flat.example".to_string(),
                token: "test-token".to_string(),
            },
            state: State::default(),
            host_dir,
        }
    }

    fn project(id: &str, key: &str, seq: u32) -> Project {
        Project {
            id: id.into(),
            key: key.into(),
            display_name: key.into(),
            description: String::new(),
            owner_ids: Vec::new(),
            created_at: "2026-08-25T12:34:56.000Z".into(),
            updated_at: "2026-08-25T12:34:56.000Z".into(),
            seq,
        }
    }

    #[test]
    fn tombstone_removes_a_second_checkouts_mirror_and_base() {
        let ticket = Ticket {
            id: "01JG4C2Q4V8XKZ3W5D9E7F2H6M".to_string(),
            key: "DEMO-1".to_string(),
            project: "00000000000000000000000000".to_string(),
            title: "Delete me".to_string(),
            body: String::new(),
            status: Status::Todo,
            priority: Priority::None,
            assignee: None,
            created_at: "2026-08-25T12:34:56.000Z".to_string(),
            updated_at: "2026-08-25T12:34:56.000Z".to_string(),
            seq: 2,
        };
        let mut first = checkout("first");
        let mut second = checkout("second");
        let rendered = markdown::render(&ticket, &BTreeMap::new()).unwrap();
        first.write_ticket(&ticket, &rendered, &rendered).unwrap();
        second.write_ticket(&ticket, &rendered, &rendered).unwrap();

        let tombstone = TicketTombstone {
            id: ticket.id.clone(),
            key: ticket.key.clone(),
            seq: 3,
        };
        second.apply_tombstones(&[tombstone]).unwrap();

        assert!(!second.mirror_path(&ticket.key).exists());
        assert!(!second.base_path(&ticket.key).exists());
        assert!(!second.state.tickets.contains_key(&ticket.key));
        assert!(second.restore_missing().unwrap().is_empty());

        std::fs::remove_dir_all(first.host_dir()).unwrap();
        std::fs::remove_dir_all(second.host_dir()).unwrap();
    }

    #[test]
    fn tickets_materialize_in_their_project_directories() {
        let mut checkout = checkout("projects");
        checkout.apply_projects(&[
            project("project-auth", "AUTH", 1),
            project("project-bill", "BILL", 2),
        ]);
        let tickets = [
            Ticket {
                id: "ticket-auth".into(),
                key: "AUTH-1".into(),
                project: "project-auth".into(),
                title: "Auth".into(),
                body: String::new(),
                status: Status::Todo,
                priority: Priority::None,
                assignee: None,
                created_at: "2026-08-25T12:34:56.000Z".into(),
                updated_at: "2026-08-25T12:34:56.000Z".into(),
                seq: 3,
            },
            Ticket {
                id: "ticket-bill".into(),
                key: "BILL-1".into(),
                project: "project-bill".into(),
                title: "Billing".into(),
                body: String::new(),
                status: Status::Todo,
                priority: Priority::None,
                assignee: None,
                created_at: "2026-08-25T12:34:56.000Z".into(),
                updated_at: "2026-08-25T12:34:56.000Z".into(),
                seq: 4,
            },
        ];
        checkout
            .apply_deltas(&tickets, &HashSet::new(), &HashMap::new())
            .unwrap();

        assert!(checkout.host_dir().join("AUTH/AUTH-1.md").exists());
        assert!(checkout.host_dir().join("BILL/BILL-1.md").exists());

        checkout
            .apply_tombstones(&[TicketTombstone {
                id: "ticket-auth".into(),
                key: "AUTH-1".into(),
                seq: 5,
            }])
            .unwrap();
        checkout
            .apply_project_tombstones(&[ProjectTombstone {
                id: "project-auth".into(),
                key: "AUTH".into(),
                seq: 6,
            }])
            .unwrap();
        assert!(!checkout.project_dir("AUTH").exists());
        assert!(checkout.project_dir("BILL").exists());

        std::fs::remove_dir_all(checkout.host_dir()).unwrap();
    }

    #[test]
    fn initialization_replaces_corrupt_state_after_preflight() {
        let root = std::env::temp_dir().join(format!("flat-init-{}", ulid::Ulid::new()));
        let config = Config {
            server: "https://flat.example".to_string(),
            token: "issued-token".to_string(),
        };
        preflight_init(&root, &config.server).unwrap();
        let state_path = root.join("flat.example/.flat/state.json");
        fs::write(&state_path, "not json").unwrap();
        save_config(&root, &config).unwrap();

        let mut checkout = Checkout::initialize(&root, config).unwrap();
        checkout.reset().unwrap();
        checkout.save_state().unwrap();

        assert_eq!(Checkout::open(&root).unwrap().state.last_seq, 0);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn old_state_without_member_cache_deserializes() {
        let state: State = serde_json::from_str(
            r#"{"last_seq":7,"tickets":{"DEMO-1":{"id":"ticket-1","seq":7}}}"#,
        )
        .unwrap();
        assert_eq!(state.last_seq, 7);
        assert!(state.members.is_empty());
    }

    #[test]
    fn unknown_assignee_suggests_sync() {
        let checkout = checkout("unknown-assignee");
        let error = checkout
            .resolve_assignee("missing@example.com")
            .unwrap_err();
        assert!(error.to_string().contains("run `flat sync`"));
    }

    #[test]
    fn invalid_assignee_preserves_the_validation_error() {
        let checkout = checkout("invalid-assignee");
        let error = checkout.resolve_assignee("not-an-email").unwrap_err();
        assert_eq!(error.to_string(), "invalid_email");
    }
}
