//! Client-side three-way merge for `flat sync --merge`.
//!
//! The server rejects a push only where both sides changed the same field
//! (atomic per ticket). Resolution happens here, where the base copy lives:
//! frontmatter fields merge value-wise, the body merges line-wise via diffy,
//! and anything both sides changed becomes git-style conflict markers for the
//! user (or their agent) to edit away before pushing again.

use std::collections::BTreeMap;

use anyhow::Result;
use flat_schema::{MemberProfile, Ticket};

use crate::markdown::{self, TicketFile};

pub struct Merged {
    pub content: String,
    /// True when the content contains conflict markers to resolve.
    pub conflicted: bool,
}

/// Whether file content contains an unresolved conflict block that flat
/// itself wrote: the exact lines `<<<<<<< local`, `=======`, `>>>>>>> server`
/// in order. Anything looser misfires on legitimate freeform bodies (a
/// fenced code block documenting a git conflict also starts lines with
/// `<<<<<<<`, and `=======` alone is a setext heading underline) and bricks
/// the ticket — an unpushable file that fails every sync. The one predicate
/// shared by everything that must not treat a half-merged file as clean
/// (`flat push` refuses it, `flat sync` exits non-zero while any remain).
pub fn has_markers(content: &str) -> bool {
    const BLOCK: [&str; 3] = ["<<<<<<< local", "=======", ">>>>>>> server"];
    let mut expect = 0;
    for line in content.lines() {
        if line == BLOCK[expect] {
            expect += 1;
            if expect == BLOCK.len() {
                return true;
            }
        }
    }
    false
}

enum Field<T> {
    Clean(T),
    Conflict { local: T, server: T },
}

impl<T> Field<T> {
    fn conflicted(&self) -> bool {
        matches!(self, Field::Conflict { .. })
    }
}

/// Classic three-way rule: take whichever side diverged from base; both
/// diverged (to different values) is a conflict.
fn pick<T: PartialEq + Clone>(base: &T, local: &T, server: &T) -> Field<T> {
    if local == base {
        Field::Clean(server.clone())
    } else if server == base || server == local {
        Field::Clean(local.clone())
    } else {
        Field::Conflict {
            local: local.clone(),
            server: server.clone(),
        }
    }
}

/// Merges a dirty mirror file (`local`, edited from `base`) with the server's
/// current row. When nothing conflicts and the local side had no edits, the
/// output is byte-identical to `markdown::render(server)`.
pub fn merge(
    base: &TicketFile,
    local: &TicketFile,
    server: &Ticket,
    members: &BTreeMap<String, MemberProfile>,
) -> Result<Merged> {
    let server_body = server.body.trim_end().to_string();
    let server_assignee = markdown::assignee_email(server, members)?;
    let title = pick(&base.title, &local.title, &server.title);
    let status = pick(&base.status, &local.status, &server.status);
    let priority = pick(&base.priority, &local.priority, &server.priority);
    let assignee = pick(&base.assignee, &local.assignee, &server_assignee);
    let body = merge_body(&base.body, &local.body, &server_body);

    let mut out = String::from("---\n");
    out.push_str(&format!("id: {}\n", server.key));
    out.push_str(&format!("project: {}\n", base.project));
    push_field(&mut out, "title", &title, |t: &String| t.clone());
    push_field(&mut out, "status", &status, |s| s.as_str().to_string());
    push_field(&mut out, "priority", &priority, |p| p.as_str().to_string());
    push_field(&mut out, "assignee", &assignee, |email| {
        email.clone().unwrap_or_else(|| "null".to_string())
    });
    out.push_str(&format!("created: {}\n", server.created_at));
    out.push_str(&format!("updated: {}\n", server.updated_at));
    out.push_str("---\n");
    let (body_text, body_conflicted) = match &body {
        Body::Clean(text) => (text.as_str(), false),
        Body::Marked(text) => (text.as_str(), true),
    };
    if !body_text.is_empty() {
        out.push('\n');
        out.push_str(body_text);
        out.push('\n');
    }
    Ok(Merged {
        content: out,
        conflicted: title.conflicted()
            || status.conflicted()
            || priority.conflicted()
            || assignee.conflicted()
            || body_conflicted,
    })
}

fn push_field<T>(out: &mut String, name: &str, field: &Field<T>, fmt: impl Fn(&T) -> String) {
    match field {
        Field::Clean(value) => out.push_str(&format!("{name}: {}\n", fmt(value))),
        Field::Conflict { local, server } => out.push_str(&format!(
            "<<<<<<< local\n{name}: {}\n=======\n{name}: {}\n>>>>>>> server\n",
            fmt(local),
            fmt(server)
        )),
    }
}

enum Body {
    Clean(String),
    /// Already contains conflict markers.
    Marked(String),
}

fn merge_body(base: &str, local: &str, server: &str) -> Body {
    if local == base {
        return Body::Clean(server.to_string());
    }
    if server == base || server == local {
        return Body::Clean(local.to_string());
    }
    // Bodies are stored without a trailing newline; diffy merges lines, so
    // hand it newline-terminated text and trim afterwards.
    let result = diffy::MergeOptions::new()
        .set_conflict_style(diffy::ConflictStyle::Merge)
        .merge(&terminated(base), &terminated(local), &terminated(server));
    match result {
        Ok(clean) => Body::Clean(clean.trim_end().to_string()),
        Err(marked) => Body::Marked(relabel(marked.trim_end())),
    }
}

fn terminated(body: &str) -> String {
    if body.is_empty() {
        String::new()
    } else {
        format!("{body}\n")
    }
}

/// diffy's marker labels are fixed at ours/theirs; ours is the mirror file
/// and theirs is the server, so relabel to match the frontmatter markers.
fn relabel(marked: &str) -> String {
    let lines: Vec<&str> = marked
        .lines()
        .map(|line| match line {
            "<<<<<<< ours" => "<<<<<<< local",
            ">>>>>>> theirs" => ">>>>>>> server",
            other => other,
        })
        .collect();
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::markdown;
    use flat_schema::{Priority, Status};

    fn members() -> BTreeMap<String, MemberProfile> {
        [
            ("member-local", "local@example.com"),
            ("member-server", "server@example.com"),
        ]
        .into_iter()
        .map(|(id, email)| {
            let member = MemberProfile {
                id: id.into(),
                email: email.into(),
                role: flat_schema::Role::Member,
                status: flat_schema::MemberStatus::Suspended,
                created_at: "2026-08-01T10:00:00.000Z".into(),
                activated_at: Some("2026-08-01T10:01:00.000Z".into()),
            };
            (member.id.clone(), member)
        })
        .collect()
    }

    fn file(title: &str, status: Status, body: &str) -> TicketFile {
        TicketFile {
            key: "DEMO-1".into(),
            project: "DEMO".into(),
            title: title.into(),
            status,
            priority: Priority::None,
            assignee: None,
            created: Some("2026-08-25T12:34:56.000Z".into()),
            updated: Some("2026-08-25T13:45:00.000Z".into()),
            body: body.into(),
        }
    }

    fn server(title: &str, status: Status, body: &str) -> Ticket {
        Ticket {
            id: "01JG4C2Q4V8XKZ3W5D9E7F2H6M".into(),
            key: "DEMO-1".into(),
            project: "00000000000000000000000000".into(),
            title: title.into(),
            body: body.into(),
            status,
            priority: Priority::None,
            assignee: None,
            created_at: "2026-08-25T12:34:56.000Z".into(),
            updated_at: "2026-08-25T14:00:00.000Z".into(),
            seq: 9,
        }
    }

    #[test]
    fn has_markers_matches_generated_conflicts_only() {
        // Both kinds of block flat writes are detected...
        let base = file("t", Status::Todo, "line");
        let frontmatter = merge(
            &base,
            &file("mine", Status::Todo, "line"),
            &server("theirs", Status::Todo, "line"),
            &BTreeMap::new(),
        )
        .unwrap();
        let body = merge(
            &base,
            &file("t", Status::Todo, "mine"),
            &server("t", Status::Todo, "theirs"),
            &BTreeMap::new(),
        )
        .unwrap();
        assert!(has_markers(&frontmatter.content));
        assert!(has_markers(&body.content));
        // ...while ordinary body text that resembles markers is not.
        assert!(!has_markers(
            "```\n<<<<<<< HEAD\ntheirs\n=======\nours\n>>>>>>> main\n```"
        ));
        assert!(!has_markers("a setext heading\n=======\n"));
        assert!(!has_markers("resolved: kept the local side\n"));
    }

    #[test]
    fn no_local_edits_yields_exact_server_render() {
        let base = file("t", Status::Todo, "body");
        let server = server("new title", Status::Done, "new body");
        let merged = merge(&base, &base.clone(), &server, &BTreeMap::new()).unwrap();
        assert!(!merged.conflicted);
        assert_eq!(
            merged.content,
            markdown::render(&server, &BTreeMap::new()).unwrap()
        );
    }

    #[test]
    fn disjoint_fields_merge_cleanly() {
        let base = file("t", Status::Todo, "body");
        let local = file("my title", Status::Todo, "body");
        let server = server("t", Status::InProgress, "body");
        let merged = merge(&base, &local, &server, &BTreeMap::new()).unwrap();
        assert!(!merged.conflicted);
        let parsed = markdown::parse(&merged.content).unwrap();
        assert_eq!(parsed.title, "my title");
        assert_eq!(parsed.status, Status::InProgress);
    }

    #[test]
    fn disjoint_body_regions_merge_cleanly() {
        let base = file(
            "t",
            Status::Todo,
            "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight",
        );
        let local = file(
            "t",
            Status::Todo,
            "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight",
        );
        let server = server(
            "t",
            Status::Todo,
            "one\ntwo\nthree\nfour\nfive\nsix\nseven\nEIGHT",
        );
        let merged = merge(&base, &local, &server, &BTreeMap::new()).unwrap();
        assert!(!merged.conflicted);
        let parsed = markdown::parse(&merged.content).unwrap();
        assert_eq!(
            parsed.body,
            "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\nEIGHT"
        );
    }

    #[test]
    fn both_sides_same_edit_is_clean() {
        let base = file("t", Status::Todo, "body");
        let local = file("t", Status::Done, "body");
        let server = server("t", Status::Done, "body");
        let merged = merge(&base, &local, &server, &BTreeMap::new()).unwrap();
        assert!(!merged.conflicted);
        assert_eq!(
            markdown::parse(&merged.content).unwrap().status,
            Status::Done
        );
    }

    #[test]
    fn conflicting_title_gets_frontmatter_markers() {
        let base = file("t", Status::Todo, "body");
        let local = file("mine", Status::Todo, "body");
        let server = server("theirs", Status::Todo, "body");
        let merged = merge(&base, &local, &server, &BTreeMap::new()).unwrap();
        assert!(merged.conflicted);
        let expected = "<<<<<<< local\ntitle: mine\n=======\ntitle: theirs\n>>>>>>> server\n";
        assert!(
            merged.content.contains(expected),
            "got:\n{}",
            merged.content
        );
        // The markers make the frontmatter unparseable, so a push of the
        // unresolved file fails even without the explicit marker guard.
        assert!(markdown::parse(&merged.content).is_err());
    }

    #[test]
    fn overlapping_body_edits_get_relabeled_markers() {
        let base = file("t", Status::Todo, "line");
        let local = file("t", Status::Todo, "mine");
        let server = server("t", Status::Todo, "theirs");
        let merged = merge(&base, &local, &server, &BTreeMap::new()).unwrap();
        assert!(merged.conflicted);
        assert!(
            merged
                .content
                .contains("<<<<<<< local\nmine\n=======\ntheirs\n>>>>>>> server"),
            "got:\n{}",
            merged.content
        );
    }

    #[test]
    fn disjoint_priority_and_assignment_edits_merge_cleanly() {
        let base = file("t", Status::Todo, "body");
        let mut local = base.clone();
        local.priority = Priority::High;
        let mut server = server("t", Status::Todo, "body");
        server.assignee = Some("member-server".into());

        let merged = merge(&base, &local, &server, &members()).unwrap();
        assert!(!merged.conflicted);
        let parsed = markdown::parse(&merged.content).unwrap();
        assert_eq!(parsed.priority, Priority::High);
        assert_eq!(parsed.assignee.as_deref(), Some("server@example.com"));
        assert_eq!(parsed.created.as_deref(), Some(server.created_at.as_str()));
        assert_eq!(parsed.updated.as_deref(), Some(server.updated_at.as_str()));
    }

    #[test]
    fn conflicting_priority_gets_frontmatter_markers() {
        let base = file("t", Status::Todo, "body");
        let mut local = base.clone();
        local.priority = Priority::High;
        let mut server = server("t", Status::Todo, "body");
        server.priority = Priority::Urgent;

        let merged = merge(&base, &local, &server, &members()).unwrap();
        assert!(merged.conflicted);
        assert!(merged
            .content
            .contains("<<<<<<< local\npriority: high\n=======\npriority: urgent\n>>>>>>> server"));
    }

    #[test]
    fn assign_versus_clear_gets_frontmatter_markers() {
        let mut base = file("t", Status::Todo, "body");
        base.assignee = Some("local@example.com".into());
        let mut local = base.clone();
        local.assignee = None;
        let mut server = server("t", Status::Todo, "body");
        server.assignee = Some("member-server".into());

        let merged = merge(&base, &local, &server, &members()).unwrap();
        assert!(merged.conflicted);
        assert!(merged.content.contains(
            "<<<<<<< local\nassignee: null\n=======\nassignee: server@example.com\n>>>>>>> server"
        ));
    }
}
