//! The out-of-repo mirror: `~/.flat/<host>/DEMO/DEMO-N.md` plus base copies
//! and sync state under `~/.flat/<host>/.flat/`. `FLAT_DIR` overrides the
//! root, which also makes a second checkout trivial.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use flat_schema::{Mutation, Ticket, TicketTombstone};
use serde::{Deserialize, Serialize};

use crate::markdown;
use crate::merge;

pub const PROJECT_KEY: &str = "DEMO";

#[derive(Debug, Serialize, Deserialize)]
pub struct Config {
    pub server: String,
    pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TicketState {
    /// The ticket's ULID; files and humans only ever see the key.
    pub id: String,
    /// Seq of the server state our base copy reflects; travels as base_seq.
    pub seq: u32,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct State {
    pub last_seq: u32,
    /// Ticket key -> local sync state.
    pub tickets: BTreeMap<String, TicketState>,
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
            Ok(raw) => serde_json::from_str(&raw).with_context(|| format!("malformed {}", state_path.display()))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => State::default(),
            Err(e) => return Err(e).context(format!("reading {}", state_path.display())),
        };
        Ok(Checkout { config, state, host_dir })
    }

    pub fn host_dir(&self) -> &Path {
        &self.host_dir
    }

    pub fn mirror_dir(&self) -> PathBuf {
        self.host_dir.join(PROJECT_KEY)
    }

    pub fn mirror_path(&self, key: &str) -> PathBuf {
        self.mirror_dir().join(format!("{key}.md"))
    }

    pub fn base_path(&self, key: &str) -> PathBuf {
        self.host_dir.join(".flat").join("base").join(format!("{key}.md"))
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
                serde_json::from_str(&raw).with_context(|| format!("malformed {}", path.display()))?,
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
        for dir in [
            self.mirror_dir(),
            self.host_dir.join(".flat").join("base"),
            self.pending_dir(),
        ] {
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
        write_atomic(&path, &format!("{}\n", serde_json::to_string_pretty(&self.state)?))
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
            let rendered = markdown::render(ticket);
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

    /// Writes the outcome of a three-way merge: the merged content (possibly
    /// holding conflict markers) becomes the mirror file, while the base copy
    /// and state advance to the server row — so the next `flat push` sends
    /// exactly the local side of the merge with a fresh base_seq.
    pub fn write_merged(&mut self, ticket: &Ticket, merged: &str) -> Result<()> {
        self.write_ticket(ticket, merged, &markdown::render(ticket))
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
            TicketState { id: ticket.id.clone(), seq: ticket.seq },
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
    let host = url.host_str().with_context(|| format!("server url {server:?} has no host"))?;
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
    let mut name = path.file_name().context("path has no file name")?.to_os_string();
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

#[cfg(test)]
mod tests {
    use flat_schema::{Status, TicketTombstone};

    use super::*;

    fn checkout(name: &str) -> Checkout {
        let host_dir = std::env::temp_dir().join(format!("flat-store-{name}-{}", ulid::Ulid::new()));
        Checkout {
            config: Config {
                server: "https://flat.example".to_string(),
                token: "test-token".to_string(),
            },
            state: State::default(),
            host_dir,
        }
    }

    #[test]
    fn tombstone_removes_a_second_checkouts_mirror_and_base() {
        let ticket = Ticket {
            id: "01JG4C2Q4V8XKZ3W5D9E7F2H6M".to_string(),
            key: "DEMO-1".to_string(),
            title: "Delete me".to_string(),
            body: String::new(),
            status: Status::Todo,
            seq: 2,
        };
        let mut first = checkout("first");
        let mut second = checkout("second");
        let rendered = markdown::render(&ticket);
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
}
