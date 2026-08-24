//! Mirror directory layout and config/state persistence.
//!
//! ```text
//! ~/.flat/<tenant-host>/          <- the mirror root (FLAT_DIR overrides)
//!   AUTH/AUTH-142.md              <- working files, agent-editable
//!   .flat/config.json             <- server URL, token, identity
//!   .flat/state.json              <- entity cache + last synced seq
//!   .flat/base/AUTH-142.md        <- pristine copies of the last sync
//! ```

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::state::State;

#[derive(Debug, Serialize, Deserialize)]
pub struct Config {
    pub server: String,
    pub token: String,
    /// Identity used for comments; matches `git config user.email`.
    pub email: String,
}

pub struct Workspace {
    pub root: PathBuf,
    pub config: Config,
}

pub fn flat_home() -> Result<PathBuf> {
    let home = std::env::var_os("HOME").context("HOME is not set")?;
    Ok(PathBuf::from(home).join(".flat"))
}

/// FLAT_DIR if set; otherwise the sole initialized mirror under `~/.flat`.
pub fn resolve_root() -> Result<PathBuf> {
    if let Some(dir) = std::env::var_os("FLAT_DIR") {
        return Ok(PathBuf::from(dir));
    }
    let home = flat_home()?;
    let mut candidates = Vec::new();
    if home.is_dir() {
        for entry in fs::read_dir(&home)? {
            let path = entry?.path();
            if path.join(".flat").join("config.json").is_file() {
                candidates.push(path);
            }
        }
    }
    match candidates.len() {
        0 => bail!("no flat mirror found under {} (run `flat init`)", home.display()),
        1 => Ok(candidates.into_iter().next().unwrap()),
        _ => bail!(
            "multiple mirrors under {}; set FLAT_DIR to one of: {}",
            home.display(),
            candidates
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

impl Workspace {
    pub fn open() -> Result<Self> {
        let root = resolve_root()?;
        let config_path = root.join(".flat").join("config.json");
        let text = fs::read_to_string(&config_path)
            .with_context(|| format!("read {} (run `flat init`)", config_path.display()))?;
        let config = serde_json::from_str(&text)
            .with_context(|| format!("parse {}", config_path.display()))?;
        Ok(Workspace { root, config })
    }

    pub fn create(root: PathBuf, config: Config) -> Result<Self> {
        fs::create_dir_all(root.join(".flat").join("base"))?;
        let ws = Workspace { root, config };
        write_atomic(
            &ws.config_path(),
            &(serde_json::to_string_pretty(&ws.config)? + "\n"),
        )?;
        Ok(ws)
    }

    pub fn config_path(&self) -> PathBuf {
        self.root.join(".flat").join("config.json")
    }

    pub fn state_path(&self) -> PathBuf {
        self.root.join(".flat").join("state.json")
    }

    pub fn ticket_path(&self, project_key: &str, ticket_key: &str) -> PathBuf {
        self.root.join(project_key).join(format!("{ticket_key}.md"))
    }

    pub fn base_path(&self, ticket_key: &str) -> PathBuf {
        self.root
            .join(".flat")
            .join("base")
            .join(format!("{ticket_key}.md"))
    }

    pub fn load_state(&self) -> Result<State> {
        let path = self.state_path();
        let text = fs::read_to_string(&path)
            .with_context(|| format!("read {} (run `flat init`)", path.display()))?;
        serde_json::from_str(&text).with_context(|| format!("parse {}", path.display()))
    }

    pub fn save_state(&self, state: &State) -> Result<()> {
        write_atomic(
            &self.state_path(),
            &(serde_json::to_string_pretty(state)? + "\n"),
        )
    }
}

pub fn write_atomic(path: &Path, contents: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, contents).with_context(|| format!("write {}", tmp.display()))?;
    fs::rename(&tmp, path).with_context(|| format!("rename into {}", path.display()))?;
    Ok(())
}
