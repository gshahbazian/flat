//! HTTP client for the tenant server.

use anyhow::{bail, Context, Result};
use flat_schema::{ErrorResponse, Snapshot, SyncRequest, SyncResponse};
use serde::de::DeserializeOwned;

pub struct Client {
    base: String,
    token: String,
    agent: ureq::Agent,
}

impl Client {
    pub fn new(server: &str, token: &str) -> Self {
        Client {
            base: server.trim_end_matches('/').to_string(),
            token: token.to_string(),
            agent: ureq::AgentBuilder::new()
                .timeout(std::time::Duration::from_secs(30))
                .build(),
        }
    }

    pub fn sync(&self, req: &SyncRequest) -> Result<SyncResponse> {
        let resp = self
            .agent
            .post(&format!("{}/sync", self.base))
            .set("Authorization", &format!("Bearer {}", self.token))
            .send_json(req);
        handle(resp)
    }

    pub fn snapshot(&self) -> Result<Snapshot> {
        let resp = self
            .agent
            .get(&format!("{}/snapshot", self.base))
            .set("Authorization", &format!("Bearer {}", self.token))
            .call();
        handle(resp)
    }
}

fn handle<T: DeserializeOwned>(resp: Result<ureq::Response, ureq::Error>) -> Result<T> {
    match resp {
        Ok(r) => r.into_json().context("malformed server response"),
        Err(ureq::Error::Status(code, r)) => {
            let body = r.into_string().unwrap_or_default();
            if let Ok(e) = serde_json::from_str::<ErrorResponse>(&body) {
                if e.error == "resync_required" {
                    bail!(
                        "the server compacted its history past this mirror's sync point; \
                         run `flat init` again to take a fresh snapshot ({})",
                        e.message
                    );
                }
                bail!("server error {code} ({}): {}", e.error, e.message);
            }
            bail!("server error {code}: {body}");
        }
        Err(e) => Err(anyhow::Error::new(e)).context("request failed"),
    }
}
