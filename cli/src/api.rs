//! HTTP client for Flat server endpoints.

use anyhow::{anyhow, Context, Result};
use flat_schema::{SearchRequest, SearchResponse, Snapshot, SyncRequest, SyncResponse};
use serde::de::DeserializeOwned;
use serde_json::Value;

pub struct Client {
    server: String,
    token: String,
    agent: ureq::Agent,
}

impl Client {
    pub fn new(server: &str, token: &str) -> Client {
        Client {
            server: server.trim_end_matches('/').to_string(),
            token: token.to_string(),
            agent: ureq::Agent::new(),
        }
    }

    pub fn sync(&self, request: &SyncRequest) -> Result<SyncResponse> {
        let response = self
            .agent
            .post(&format!("{}/sync", self.server))
            .set("Authorization", &format!("Bearer {}", self.token))
            .set("Content-Type", "application/json")
            .send_string(&serde_json::to_string(request)?);
        parse_response(response, "POST /sync")
    }

    pub fn snapshot(&self) -> Result<Snapshot> {
        let response = self
            .agent
            .get(&format!("{}/snapshot", self.server))
            .set("Authorization", &format!("Bearer {}", self.token))
            .call();
        parse_response(response, "GET /snapshot")
    }

    pub fn search(&self, request: &SearchRequest) -> Result<SearchResponse> {
        let response = self
            .agent
            .post(&format!("{}/search", self.server))
            .set("Authorization", &format!("Bearer {}", self.token))
            .set("Content-Type", "application/json")
            .send_string(&serde_json::to_string(request)?);
        parse_response(response, "POST /search")
    }

    pub fn post<T: DeserializeOwned>(&self, path: &str, body: &Value) -> Result<T> {
        let response = self
            .agent
            .post(&format!("{}{}", self.server, path))
            .set("Authorization", &format!("Bearer {}", self.token))
            .set("Content-Type", "application/json")
            .send_string(&serde_json::to_string(body)?);
        parse_response(response, &format!("POST {path}"))
    }

    pub fn post_public<T: DeserializeOwned>(server: &str, path: &str, body: &Value) -> Result<T> {
        let response = ureq::post(&format!("{}{}", server.trim_end_matches('/'), path))
            .set("Content-Type", "application/json")
            .send_string(&serde_json::to_string(body)?);
        parse_response(response, &format!("POST {path}"))
    }

    pub fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        let response = self
            .agent
            .get(&format!("{}{}", self.server, path))
            .set("Authorization", &format!("Bearer {}", self.token))
            .call();
        parse_response(response, &format!("GET {path}"))
    }
}

fn parse_response<T: DeserializeOwned>(
    response: Result<ureq::Response, ureq::Error>,
    what: &str,
) -> Result<T> {
    match response {
        Ok(response) => {
            let mut body = response
                .into_string()
                .with_context(|| format!("{what}: reading body"))?;
            if body.trim().is_empty() {
                body = "null".to_string();
            }
            serde_json::from_str(&body)
                .with_context(|| format!("{what}: unexpected response: {body}"))
        }
        Err(ureq::Error::Status(code, response)) => {
            let body = response.into_string().unwrap_or_default();
            let detail = server_error_detail(&body).unwrap_or(body);
            Err(anyhow!("{what} failed ({code}): {detail}"))
        }
        Err(e) => Err(anyhow!("{what} failed: {e}")),
    }
}

fn server_error_detail(body: &str) -> Option<String> {
    let value = serde_json::from_str::<serde_json::Value>(body).ok()?;
    let error = value.get("error")?.as_str()?;
    let mut detail = error.to_string();
    if let Some(message) = value.get("message").and_then(serde_json::Value::as_str) {
        detail.push_str(": ");
        detail.push_str(message);
    }
    if let Some(offset) = value.get("offset").and_then(serde_json::Value::as_u64) {
        detail.push_str(&format!(" (byte {offset})"));
    }
    Some(detail)
}

#[cfg(test)]
mod tests {
    use super::server_error_detail;

    #[test]
    fn search_errors_keep_the_message_and_byte_offset() {
        assert_eq!(
            server_error_detail(
                r#"{"error":"invalid_search_query","message":"unknown status \"working\"","offset":10}"#
            )
            .as_deref(),
            Some("invalid_search_query: unknown status \"working\" (byte 10)")
        );
    }

    #[test]
    fn ordinary_api_errors_keep_the_existing_shape() {
        assert_eq!(
            server_error_detail(r#"{"error":"forbidden"}"#).as_deref(),
            Some("forbidden")
        );
        assert_eq!(server_error_detail("not json"), None);
    }
}
