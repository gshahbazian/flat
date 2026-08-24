//! The agent-facing file format: markdown with YAML-ish frontmatter.
//!
//! This module is the only reader and writer of the format, and it renders
//! canonically: dirtiness is detected by comparing working-file bytes to the
//! base copy, so render(parse(render(t))) must be byte-stable.

use anyhow::{bail, Context, Result};
use flat_schema::{Comment, Priority, Status, Ticket};

pub const SENTINEL: &str = "<!-- flat:comments -->";

/// Parsed working file. `below_sentinel` is kept raw (comments are
/// read-only; push compares it byte-for-byte against the base copy).
#[derive(Debug, Clone, PartialEq)]
pub struct TicketFile {
    pub id: String,
    pub title: String,
    pub status: Status,
    pub priority: Priority,
    pub assignee: Option<String>,
    pub labels: Vec<String>,
    pub project: String,
    pub created: String,
    pub updated: String,
    pub body: String,
    pub below_sentinel: String,
}

pub fn has_conflict_markers(text: &str) -> bool {
    text.lines()
        .any(|l| l.starts_with("<<<<<<< ") || l == "=======" || l.starts_with(">>>>>>> "))
}

fn comment_heading(c: &Comment) -> String {
    match &c.on_behalf_of {
        Some(email) => format!("{} (for {})", c.author, email),
        None => c.author.clone(),
    }
}

pub fn render_comments(comments: &[&Comment]) -> String {
    let mut s = format!("{SENTINEL}\n## Comments\n");
    for c in comments {
        s.push_str(&format!(
            "\n### {} — {}\n{}\n",
            comment_heading(c),
            c.created,
            c.body.trim_end()
        ));
    }
    s
}

pub fn render(ticket: &Ticket, project_key: &str, comments: &[&Comment]) -> String {
    let mut s = String::from("---\n");
    s.push_str(&format!("id: {}\n", ticket.key));
    s.push_str(&format!("title: {}\n", ticket.title));
    s.push_str(&format!("status: {}\n", ticket.status.as_str()));
    s.push_str(&format!("priority: {}\n", ticket.priority.as_str()));
    s.push_str(&format!(
        "assignee: {}\n",
        ticket.assignee.as_deref().unwrap_or("null")
    ));
    s.push_str(&format!("labels: [{}]\n", ticket.labels.join(", ")));
    s.push_str(&format!("project: {project_key}\n"));
    s.push_str(&format!("created: {}\n", ticket.created));
    s.push_str(&format!("updated: {}\n", ticket.updated));
    s.push_str("---\n\n");
    let body = ticket.description.trim();
    if !body.is_empty() {
        s.push_str(body);
        s.push_str("\n\n");
    }
    s.push_str(&render_comments(comments));
    s
}

pub fn parse(text: &str) -> Result<TicketFile> {
    let rest = text
        .strip_prefix("---\n")
        .context("file must start with `---` frontmatter")?;
    let (front, rest) = rest
        .split_once("\n---\n")
        .context("unterminated frontmatter (missing closing `---`)")?;

    let (above, below_sentinel) = match rest.find(SENTINEL) {
        Some(pos) => (&rest[..pos], rest[pos..].to_string()),
        None => (rest, String::new()),
    };
    let body = above.trim().to_string();

    let mut id = None;
    let mut title = None;
    let mut status = None;
    let mut priority = None;
    let mut assignee: Option<String> = None;
    let mut labels: Vec<String> = Vec::new();
    let mut project = None;
    let mut created = None;
    let mut updated = None;

    for line in front.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let (key, value) = line
            .split_once(':')
            .with_context(|| format!("bad frontmatter line: {line:?}"))?;
        let key = key.trim();
        let value = value.trim();
        match key {
            "id" => id = Some(value.to_string()),
            "title" => title = Some(value.to_string()),
            "status" => status = Some(value.parse::<Status>().map_err(anyhow::Error::msg)?),
            "priority" => priority = Some(value.parse::<Priority>().map_err(anyhow::Error::msg)?),
            "assignee" => {
                assignee = match value {
                    "" | "null" | "~" => None,
                    v => Some(v.to_string()),
                }
            }
            "labels" => {
                let inner = value
                    .strip_prefix('[')
                    .and_then(|v| v.strip_suffix(']'))
                    .with_context(|| format!("labels must look like [a, b], got {value:?}"))?;
                labels = inner
                    .split(',')
                    .map(|l| l.trim().to_string())
                    .filter(|l| !l.is_empty())
                    .collect();
            }
            "project" => project = Some(value.to_string()),
            "created" => created = Some(value.to_string()),
            "updated" => updated = Some(value.to_string()),
            other => bail!("unknown frontmatter field: {other}"),
        }
    }

    let title = title.context("missing frontmatter field: title")?;
    if title.is_empty() {
        bail!("title cannot be empty");
    }
    Ok(TicketFile {
        id: id.context("missing frontmatter field: id")?,
        title,
        status: status.context("missing frontmatter field: status")?,
        priority: priority.context("missing frontmatter field: priority")?,
        assignee,
        labels,
        project: project.context("missing frontmatter field: project")?,
        created: created.context("missing frontmatter field: created")?,
        updated: updated.context("missing frontmatter field: updated")?,
        body,
        below_sentinel,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ticket() -> Ticket {
        Ticket {
            id: "01JCZX6T4SR0WV6P5B4X4E9K1T".into(),
            key: "AUTH-142".into(),
            project_id: "01JCZWZQ8B3F2M7N9P4R5S6T7V".into(),
            number: 142,
            title: "Fix OAuth token refresh race: part 2".into(),
            status: Status::InProgress,
            priority: Priority::High,
            assignee: Some("gabe@acme.com".into()),
            labels: vec!["auth".into(), "bug".into()],
            description: "Body line one.\n\nBody line two.".into(),
            created: "2025-11-30T18:04:11Z".into(),
            updated: "2025-12-01T09:22:41Z".into(),
            seq: 4021,
        }
    }

    fn comment() -> Comment {
        Comment {
            id: "01JCZXA2Q9K8J7H6G5F4D3S2A1".into(),
            ticket_id: "01JCZX6T4SR0WV6P5B4X4E9K1T".into(),
            author: "claude".into(),
            on_behalf_of: Some("gabe@acme.com".into()),
            body: "Fix in PR #482.".into(),
            created: "2025-11-30T19:02:11Z".into(),
            seq: 4030,
        }
    }

    #[test]
    fn render_parse_roundtrip() {
        let t = ticket();
        let c = comment();
        let text = render(&t, "AUTH", &[&c]);
        let parsed = parse(&text).unwrap();
        assert_eq!(parsed.id, "AUTH-142");
        assert_eq!(parsed.title, t.title);
        assert_eq!(parsed.status, Status::InProgress);
        assert_eq!(parsed.priority, Priority::High);
        assert_eq!(parsed.assignee.as_deref(), Some("gabe@acme.com"));
        assert_eq!(parsed.labels, t.labels);
        assert_eq!(parsed.project, "AUTH");
        assert_eq!(parsed.body, t.description);
        assert!(parsed.below_sentinel.contains("claude (for gabe@acme.com)"));
        // Canonical: re-rendering the parsed content is byte-identical.
        let mut t2 = t.clone();
        t2.title = parsed.title.clone();
        t2.description = parsed.body.clone();
        assert_eq!(render(&t2, "AUTH", &[&c]), text);
    }

    #[test]
    fn empty_description_and_no_comments() {
        let mut t = ticket();
        t.description = String::new();
        t.assignee = None;
        t.labels = vec![];
        let text = render(&t, "AUTH", &[]);
        let parsed = parse(&text).unwrap();
        assert_eq!(parsed.body, "");
        assert_eq!(parsed.assignee, None);
        assert!(parsed.labels.is_empty());
        assert_eq!(render(&t, "AUTH", &[]), text);
    }

    #[test]
    fn detects_conflict_markers() {
        assert!(has_conflict_markers("a\n<<<<<<< local\nx\n=======\ny\n>>>>>>> server\n"));
        assert!(!has_conflict_markers("plain text"));
    }

    #[test]
    fn rejects_unknown_field() {
        let text = "---\nid: A-1\nfoo: bar\n---\n";
        assert!(parse(text).unwrap_err().to_string().contains("unknown frontmatter field"));
    }
}
