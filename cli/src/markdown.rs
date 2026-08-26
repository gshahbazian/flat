//! The agent-facing markdown format. This is the API that gets baked into
//! prompts, so it stays boring:
//!
//! ```markdown
//! ---
//! id: DEMO-1
//! project: DEMO
//! title: Fix OAuth token refresh race
//! status: todo
//! priority: high
//! assignee: gabe@example.com
//! created: 2026-08-25T12:34:56.000Z
//! updated: 2026-08-25T13:45:00.000Z
//! ---
//!
//! Description body.
//!
//! <!-- flat:comments -->
//! ## Comments
//! ```
//!
//! Editable: title, status, priority, assignee, body. Read-only: id, project,
//! created, updated, and the rendered comment section.

use std::collections::BTreeMap;

use anyhow::{bail, Context, Result};
use flat_schema::{Comment, MemberProfile, Priority, Status, Ticket, TokenKind};

pub use flat_schema::COMMENT_SENTINEL;

/// The editable fields of one ticket file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TicketFile {
    pub key: String,
    pub project: String,
    pub title: String,
    pub status: Status,
    pub priority: Priority,
    pub assignee: Option<String>,
    /// Missing only for a pre-priority mirror that has not synced yet.
    pub created: Option<String>,
    /// Missing only for a pre-priority mirror that has not synced yet.
    pub updated: Option<String>,
    pub body: String,
    /// Rendered suffix beginning at the sentinel.
    pub comments: String,
}

pub(crate) fn assignee_email(
    ticket: &Ticket,
    members: &BTreeMap<String, MemberProfile>,
) -> Result<Option<String>> {
    ticket
        .assignee
        .as_ref()
        .map(|id| {
            members
                .get(id)
                .map(|member| member.email.clone())
                .with_context(|| {
                    format!("missing member profile for assignee {id}; run `flat sync`")
                })
        })
        .transpose()
}

pub fn render(
    ticket: &Ticket,
    members: &BTreeMap<String, MemberProfile>,
    comments: &[Comment],
) -> Result<String> {
    flat_schema::validate_ticket_body(&ticket.body).map_err(anyhow::Error::msg)?;
    let assignee = assignee_email(ticket, members)?;
    let assignee = assignee.as_deref().unwrap_or("null");
    let project = ticket
        .key
        .rsplit_once('-')
        .map(|(project, _)| project)
        .context("ticket key has no project prefix")?;
    let mut out = format!(
        "---\nid: {}\nproject: {}\ntitle: {}\nstatus: {}\npriority: {}\nassignee: {}\ncreated: {}\nupdated: {}\n---\n",
        ticket.key,
        project,
        ticket.title,
        ticket.status.as_str(),
        ticket.priority.as_str(),
        assignee,
        ticket.created_at,
        ticket.updated_at
    );
    let body = ticket.body.trim_end();
    if !body.is_empty() {
        out.push('\n');
        out.push_str(body);
        out.push('\n');
    }
    out.push_str(&render_comment_section(comments, members)?);
    Ok(out)
}

pub fn render_comment_section(
    comments: &[Comment],
    members: &BTreeMap<String, MemberProfile>,
) -> Result<String> {
    let mut out = format!("\n{COMMENT_SENTINEL}\n## Comments\n");
    let mut comments: Vec<&Comment> = comments.iter().collect();
    comments.sort_by_key(|comment| comment.seq);
    for comment in comments {
        let member = members.get(&comment.member_id).with_context(|| {
            format!(
                "missing member profile for comment author {}; run `flat sync`",
                comment.member_id
            )
        })?;
        let author = match comment.token_kind {
            TokenKind::Human => member.email.clone(),
            TokenKind::Agent => {
                let agent = comment
                    .agent_name
                    .as_deref()
                    .context("agent comment is missing its agent name")?;
                if let Some(delegating_id) = &comment.delegating_member_id {
                    let delegating = members.get(delegating_id).with_context(|| {
                        format!(
                            "missing member profile for delegating member {delegating_id}; run `flat sync`"
                        )
                    })?;
                    format!(
                        "{agent} (for {}, delegated by {})",
                        member.email, delegating.email
                    )
                } else {
                    format!("{agent} (for {})", member.email)
                }
            }
        };
        out.push_str(&format!("\n### {author} — {}\n", comment.created_at));
        out.push_str(comment.body.trim_end());
        out.push('\n');
    }
    Ok(out)
}

pub(crate) fn split_comment_section(content: &str) -> Result<(&str, &str)> {
    let mut offset = 0;
    for line in content.split_inclusive('\n') {
        if line.trim_end_matches(['\r', '\n']) == COMMENT_SENTINEL {
            return Ok((&content[..offset], &content[offset..]));
        }
        offset += line.len();
    }
    bail!(
        "ticket file is missing `{COMMENT_SENTINEL}`; restore it or delete the file and run `flat sync`"
    );
}

pub(crate) fn comment_sections_equal(left: &str, right: &str) -> bool {
    let left = left.replace("\r\n", "\n");
    let right = right.replace("\r\n", "\n");
    left.trim_end_matches('\n') == right.trim_end_matches('\n')
}

pub(crate) fn replace_unchanged_comment_section(
    content: &str,
    base: &str,
    replacement: &str,
) -> Option<String> {
    let (editable, current_comments) = split_comment_section(content).ok()?;
    let (_, base_comments) = split_comment_section(base).ok()?;
    if !comment_sections_equal(current_comments, base_comments) {
        return None;
    }
    let (_, replacement_comments) = split_comment_section(replacement).ok()?;
    Some(format!("{editable}{replacement_comments}"))
}

pub fn parse(content: &str) -> Result<TicketFile> {
    let (editable, comments) = split_comment_section(content)?;
    let mut lines = editable.lines();
    if lines.next() != Some("---") {
        bail!("file must start with `---` frontmatter");
    }

    let mut id = None;
    let mut project = None;
    let mut title = None;
    let mut status = None;
    let mut priority = None;
    let mut assignee = None;
    let mut created = None;
    let mut updated = None;
    loop {
        let line = lines
            .next()
            .context("frontmatter is missing its closing `---`")?;
        if line == "---" {
            break;
        }
        let (field, value) = line
            .split_once(':')
            .with_context(|| format!("malformed frontmatter line {line:?}"))?;
        let value = value.trim();
        match field.trim() {
            "id" => id = Some(value.to_string()),
            "project" => project = Some(value.to_string()),
            "title" => title = Some(value.to_string()),
            "status" => status = Some(value.parse::<Status>().map_err(anyhow::Error::msg)?),
            "priority" => {
                priority = Some(value.parse::<Priority>().map_err(anyhow::Error::msg)?)
            }
            "assignee" => {
                assignee = Some(if value == "null" {
                    None
                } else {
                    Some(flat_schema::normalize_email(value).map_err(anyhow::Error::msg)?)
                })
            }
            "created" => created = Some(value.to_string()),
            "updated" => updated = Some(value.to_string()),
            other => bail!(
                "unknown frontmatter field {other:?} (fields: id, project, title, status, priority, assignee, created, updated)"
            ),
        }
    }

    let title = title.context("frontmatter is missing `title`")?;
    flat_schema::validate_title(&title).map_err(anyhow::Error::msg)?;

    let body: Vec<&str> = lines.collect();
    let body = body.join("\n");
    Ok(TicketFile {
        key: id.context("frontmatter is missing `id`")?,
        project: project.context("frontmatter is missing `project`")?,
        title,
        status: status.context("frontmatter is missing `status`")?,
        priority: priority.unwrap_or(Priority::None),
        assignee: assignee.unwrap_or(None),
        created,
        updated,
        body: body.trim_start_matches('\n').trim_end().to_string(),
        comments: comments.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ticket(title: &str, status: Status, body: &str) -> Ticket {
        Ticket {
            id: "01JG4C2Q4V8XKZ3W5D9E7F2H6M".into(),
            key: "DEMO-1".into(),
            project: "00000000000000000000000000".into(),
            title: title.into(),
            body: body.into(),
            status,
            priority: Priority::High,
            assignee: None,
            created_at: "2026-08-25T12:34:56.000Z".into(),
            updated_at: "2026-08-25T13:45:00.000Z".into(),
            seq: 7,
        }
    }

    fn members() -> BTreeMap<String, MemberProfile> {
        [MemberProfile {
            id: "01JG4BZ4M6PQRSTVWXYZ012345".into(),
            email: "gabe@acme.com".into(),
            role: flat_schema::Role::Admin,
            status: flat_schema::MemberStatus::Active,
            created_at: "2026-08-01T10:00:00.000Z".into(),
            activated_at: Some("2026-08-01T10:01:00.000Z".into()),
        }]
        .into_iter()
        .map(|member| (member.id.clone(), member))
        .collect()
    }

    #[test]
    fn render_parse_round_trips() {
        for t in [
            ticket("hello", Status::Todo, ""),
            ticket(
                "fix: colons: everywhere",
                Status::InProgress,
                "line one\n\nline two",
            ),
            ticket("done thing", Status::Done, "trailing newline\n"),
        ] {
            let parsed = parse(&render(&t, &members(), &[]).unwrap()).unwrap();
            assert_eq!(parsed.key, t.key);
            assert_eq!(parsed.project, "DEMO");
            assert_eq!(parsed.title, t.title);
            assert_eq!(parsed.status, t.status);
            assert_eq!(parsed.priority, t.priority);
            assert_eq!(parsed.assignee, None);
            assert_eq!(parsed.created.as_deref(), Some(t.created_at.as_str()));
            assert_eq!(parsed.updated.as_deref(), Some(t.updated_at.as_str()));
            assert_eq!(parsed.body, t.body.trim_end());
            assert!(parsed.comments.starts_with(COMMENT_SENTINEL));
        }
    }

    #[test]
    fn renders_assigned_and_unassigned_tickets() {
        let mut assigned = ticket("assigned", Status::Todo, "");
        assigned.assignee = Some("01JG4BZ4M6PQRSTVWXYZ012345".into());
        let rendered = render(&assigned, &members(), &[]).unwrap();
        assert!(rendered.contains("priority: high\nassignee: gabe@acme.com\n"));
        assert_eq!(
            parse(&rendered).unwrap().assignee.as_deref(),
            Some("gabe@acme.com")
        );

        let rendered = render(&ticket("unassigned", Status::Todo, ""), &members(), &[]).unwrap();
        assert!(rendered.contains("assignee: null\n"));
        assert_eq!(parse(&rendered).unwrap().assignee, None);
    }

    #[test]
    fn renders_ordered_human_agent_and_delegated_comments() {
        let mut members = members();
        for (id, email) in [
            ("member-maya", "maya@acme.com"),
            ("member-admin", "admin@acme.com"),
        ] {
            members.insert(
                id.into(),
                MemberProfile {
                    id: id.into(),
                    email: email.into(),
                    role: flat_schema::Role::Member,
                    status: flat_schema::MemberStatus::Suspended,
                    created_at: "2026-08-01T10:00:00.000Z".into(),
                    activated_at: Some("2026-08-01T10:01:00.000Z".into()),
                },
            );
        }
        let comment = |id: &str,
                       seq: u32,
                       token_kind: TokenKind,
                       agent_name: Option<&str>,
                       delegating_member_id: Option<&str>| Comment {
            id: id.into(),
            ticket_id: "01JG4C2Q4V8XKZ3W5D9E7F2H6M".into(),
            body: format!("body {seq}"),
            member_id: if token_kind == TokenKind::Human {
                "01JG4BZ4M6PQRSTVWXYZ012345".into()
            } else {
                "member-maya".into()
            },
            token_id: format!("token-{seq}"),
            token_kind,
            agent_name: agent_name.map(str::to_string),
            delegating_member_id: delegating_member_id.map(str::to_string),
            created_at: format!("2026-08-25T13:4{seq}:00.000Z"),
            seq,
        };
        let rendered = render(
            &ticket("comments", Status::Todo, "description"),
            &members,
            &[
                comment(
                    "delegated",
                    3,
                    TokenKind::Agent,
                    Some("ticket-triage"),
                    Some("member-admin"),
                ),
                comment("human", 1, TokenKind::Human, None, None),
                comment("agent", 2, TokenKind::Agent, Some("claude"), None),
            ],
        )
        .unwrap();
        let human = rendered.find("### gabe@acme.com —").unwrap();
        let agent = rendered.find("### claude (for maya@acme.com) —").unwrap();
        let delegated = rendered
            .find("### ticket-triage (for maya@acme.com, delegated by admin@acme.com) —")
            .unwrap();
        assert!(human < agent && agent < delegated);
        let parsed = parse(&rendered).unwrap();
        assert_eq!(parsed.body, "description");
        assert!(parsed.comments.starts_with(COMMENT_SENTINEL));
    }

    #[test]
    fn rejects_unknown_fields() {
        let err = parse(
            "---\nid: DEMO-1\nproject: DEMO\ntitle: x\nstatus: todo\nwat: high\n---\n\n<!-- flat:comments -->\n## Comments\n",
        )
        .unwrap_err();
        assert!(err.to_string().contains("unknown frontmatter field"));
    }

    #[test]
    fn rejects_empty_title() {
        let err = parse(
            "---\nid: DEMO-1\nproject: DEMO\ntitle:\nstatus: todo\n---\n\n<!-- flat:comments -->\n## Comments\n",
        )
        .unwrap_err();
        assert!(err.to_string().contains("title must not be empty"));
    }

    #[test]
    fn rejects_unknown_status() {
        let err = parse(
            "---\nid: DEMO-1\nproject: DEMO\ntitle: x\nstatus: shipped\n---\n\n<!-- flat:comments -->\n## Comments\n",
        )
        .unwrap_err();
        assert!(err.to_string().contains("unknown status"));
    }

    #[test]
    fn rejects_unknown_priority() {
        let err = parse(
            "---\nid: DEMO-1\nproject: DEMO\ntitle: x\nstatus: todo\npriority: critical\n---\n\n<!-- flat:comments -->\n## Comments\n",
        )
        .unwrap_err();
        assert!(err.to_string().contains("unknown priority"));
    }

    #[test]
    fn accepts_frontmatter_without_optional_fields() {
        let parsed = parse(
            "---\nid: DEMO-1\nproject: DEMO\ntitle: x\nstatus: todo\n---\nbody\n\n<!-- flat:comments -->\n## Comments\n",
        )
        .unwrap();
        assert_eq!(parsed.priority, Priority::None);
        assert_eq!(parsed.assignee, None);
        assert_eq!(parsed.created, None);
        assert_eq!(parsed.updated, None);
    }

    #[test]
    fn rejects_files_without_comment_sentinel() {
        let error =
            parse("---\nid: DEMO-1\nproject: DEMO\ntitle: x\nstatus: todo\n---\n").unwrap_err();
        assert!(error
            .to_string()
            .contains("missing `<!-- flat:comments -->`"));
    }

    #[test]
    fn comment_sections_ignore_crlf_and_trailing_newlines() {
        let canonical = "<!-- flat:comments -->\n## Comments\n\n### author — now\nbody\n";
        let normalized =
            "<!-- flat:comments -->\r\n## Comments\r\n\r\n### author — now\r\nbody\r\n\r\n";
        assert!(comment_sections_equal(canonical, normalized));
        assert!(!comment_sections_equal(
            canonical,
            "<!-- flat:comments -->\n## Comments\n\n### author — now\nchanged\n"
        ));
    }
}
