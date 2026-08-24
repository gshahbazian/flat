//! The agent-facing markdown format. This is the API that gets baked into
//! prompts, so it stays boring:
//!
//! ```markdown
//! ---
//! id: DEMO-1
//! title: Fix OAuth token refresh race
//! status: todo
//! ---
//!
//! Description body.
//! ```
//!
//! Editable: title, status, body. Read-only: id.

use anyhow::{bail, Context, Result};
use flat_schema::{Status, Ticket};

/// The editable fields of one ticket file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TicketFile {
    pub key: String,
    pub title: String,
    pub status: Status,
    pub body: String,
}

pub fn render(ticket: &Ticket) -> String {
    let mut out = format!(
        "---\nid: {}\ntitle: {}\nstatus: {}\n---\n",
        ticket.key,
        ticket.title,
        ticket.status.as_str()
    );
    let body = ticket.body.trim_end();
    if !body.is_empty() {
        out.push('\n');
        out.push_str(body);
        out.push('\n');
    }
    out
}

pub fn parse(content: &str) -> Result<TicketFile> {
    let mut lines = content.lines();
    if lines.next() != Some("---") {
        bail!("file must start with `---` frontmatter");
    }

    let mut id = None;
    let mut title = None;
    let mut status = None;
    loop {
        let line = lines.next().context("frontmatter is missing its closing `---`")?;
        if line == "---" {
            break;
        }
        let (field, value) = line
            .split_once(':')
            .with_context(|| format!("malformed frontmatter line {line:?}"))?;
        let value = value.trim();
        match field.trim() {
            "id" => id = Some(value.to_string()),
            "title" => title = Some(value.to_string()),
            "status" => status = Some(value.parse::<Status>().map_err(anyhow::Error::msg)?),
            other => bail!("unknown frontmatter field {other:?} (fields: id, title, status)"),
        }
    }

    let title = title.context("frontmatter is missing `title`")?;
    flat_schema::validate_title(&title).map_err(anyhow::Error::msg)?;

    let body: Vec<&str> = lines.collect();
    let body = body.join("\n");
    Ok(TicketFile {
        key: id.context("frontmatter is missing `id`")?,
        title,
        status: status.context("frontmatter is missing `status`")?,
        body: body.trim_start_matches('\n').trim_end().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ticket(title: &str, status: Status, body: &str) -> Ticket {
        Ticket {
            id: "01JG4C2Q4V8XKZ3W5D9E7F2H6M".into(),
            key: "DEMO-1".into(),
            title: title.into(),
            body: body.into(),
            status,
            seq: 7,
        }
    }

    #[test]
    fn render_parse_round_trips() {
        for t in [
            ticket("hello", Status::Todo, ""),
            ticket("fix: colons: everywhere", Status::InProgress, "line one\n\nline two"),
            ticket("done thing", Status::Done, "trailing newline\n"),
        ] {
            let parsed = parse(&render(&t)).unwrap();
            assert_eq!(parsed.key, t.key);
            assert_eq!(parsed.title, t.title);
            assert_eq!(parsed.status, t.status);
            assert_eq!(parsed.body, t.body.trim_end());
        }
    }

    #[test]
    fn rejects_unknown_fields() {
        let err = parse("---\nid: DEMO-1\ntitle: x\nstatus: todo\npriority: high\n---\n").unwrap_err();
        assert!(err.to_string().contains("unknown frontmatter field"));
    }

    #[test]
    fn rejects_empty_title() {
        let err = parse("---\nid: DEMO-1\ntitle:\nstatus: todo\n---\n").unwrap_err();
        assert!(err.to_string().contains("title must not be empty"));
    }

    #[test]
    fn rejects_unknown_status() {
        let err = parse("---\nid: DEMO-1\ntitle: x\nstatus: shipped\n---\n").unwrap_err();
        assert!(err.to_string().contains("unknown status"));
    }
}
