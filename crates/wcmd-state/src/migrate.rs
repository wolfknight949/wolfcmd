//! N-05 / N-03: reading `workspaces.json` of any format this WolfCmd knows, brought up to
//! [`CURRENT_VERSION`] one step at a time on the parsed JSON, before it becomes a [`Document`].
//! Never lose user state: every format change adds a step here and a test with a real
//! file of the older format. A file of a newer format is never migrated (`file.rs` shows it
//! read-only).
//!
//! - 1 → 2 (N-03 panel types): a panel's `profile`, `cwd` and `agent` move into its `content`,
//!   a `{ "kind": "terminal", … }` object.

use serde_json::{Map, Value};

use crate::document::{CURRENT_VERSION, Document, TERMINAL_KIND};

/// A file's document, brought up to the current format.
#[derive(Debug, Clone)]
pub(crate) struct Parsed {
    /// Normalized, at [`CURRENT_VERSION`].
    pub(crate) document: Document,
    /// The format the file had (older than [`CURRENT_VERSION`]: it was migrated).
    pub(crate) from: u64,
}

/// The format of a file's bytes, when they are JSON with a numeric `version`.
pub(crate) fn version_of(bytes: &[u8]) -> Option<u64> {
    let value = serde_json::from_slice::<Value>(bytes).ok()?;
    value.get("version").and_then(Value::as_u64)
}

/// A document this WolfCmd can use: valid UTF-8 JSON of a format it knows (older ones migrated),
/// normalized. `None` for anything else (damaged, or from a newer WolfCmd).
pub(crate) fn parse(bytes: &[u8]) -> Option<Parsed> {
    let text = std::str::from_utf8(bytes).ok()?;
    let mut value = serde_json::from_str::<Value>(text).ok()?;
    let from = value.get("version").and_then(Value::as_u64)?;
    if from > u64::from(CURRENT_VERSION) {
        return None;
    }
    upgrade(&mut value, from);
    let document = serde_json::from_value::<Document>(value).ok()?;
    Some(Parsed {
        document: document.normalized(),
        from,
    })
}

/// Runs every step from format `from` up to [`CURRENT_VERSION`] on `value`.
fn upgrade(value: &mut Value, from: u64) {
    if from < 2 {
        v1_to_v2(value);
    }
}

/// 1 → 2: every panel's terminal fields go into `content: { kind: "terminal", … }`.
fn v1_to_v2(document: &mut Value) {
    let workspaces = document
        .get_mut("workspaces")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten();
    for workspace in workspaces {
        let tabs = workspace
            .get_mut("tabs")
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten();
        for tab in tabs {
            if let Some(layout) = tab.get_mut("layout") {
                layout_v1_to_v2(layout);
            }
        }
    }
    if let Some(object) = document.as_object_mut() {
        object.insert("version".to_owned(), Value::from(2));
    }
}

fn layout_v1_to_v2(node: &mut Value) {
    let Some(object) = node.as_object_mut() else {
        return;
    };
    match object.get("kind").and_then(Value::as_str) {
        Some("split") => {
            let children = object
                .get_mut("children")
                .and_then(Value::as_array_mut)
                .into_iter()
                .flatten();
            for child in children {
                layout_v1_to_v2(child);
            }
        }
        Some("panel") if !object.contains_key("content") => {
            let mut content = Map::new();
            content.insert("kind".to_owned(), Value::from(TERMINAL_KIND));
            for key in ["profile", "cwd", "agent"] {
                if let Some(field) = object.remove(key) {
                    content.insert(key.to_owned(), field);
                }
            }
            object.insert("content".to_owned(), Value::Object(content));
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::{AgentRef, Direction, Layout, PanelContent, TerminalContent};

    /// A real format 1 file (`fixtures/workspaces-v1.json`): two workspaces, a split with an agent
    /// panel and plain shells, a maximized panel, a worktree workspace and an agent that had ended.
    const V1_FILE: &str = include_str!("../fixtures/workspaces-v1.json");

    fn terminal(layout: &Layout) -> &TerminalContent {
        let Layout::Panel(panel) = layout else {
            panic!("a panel");
        };
        panel.content.terminal().expect("a terminal")
    }

    #[test]
    fn n03_a_v1_file_migrates_with_every_panel_agent_ratio_maximized_and_main() {
        let parsed = parse(V1_FILE.as_bytes()).expect("a v1 file parses");
        assert_eq!(parsed.from, 1);
        let doc = parsed.document;
        assert_eq!(doc.version, CURRENT_VERSION);
        assert_eq!(doc.active.as_deref(), Some("w-tree"));
        let app = &doc.workspaces[0];
        let tab = &app.tabs[0];
        assert_eq!(tab.maximized.as_deref(), Some("p-agent"));
        assert_eq!(tab.focused.as_deref(), Some("p-shell"));
        assert_eq!(app.tabs[1].layout, None);
        let Some(Layout::Split {
            ratios,
            children,
            direction,
            ..
        }) = &tab.layout
        else {
            panic!("the split");
        };
        assert_eq!(
            (*direction, ratios.as_slice()),
            (Direction::Row, &[0.65, 0.35][..])
        );
        let agent = terminal(&children[0]);
        assert_eq!(agent.profile.as_deref(), Some("pwsh"));
        assert_eq!(agent.cwd.as_deref(), Some(r"C:\dev\app\src"));
        assert_eq!(
            agent.agent,
            Some(AgentRef {
                agent: "claude-code".into(),
                session: Some("3f2a1c9e-0b1d-4f6a-8c2e-9a7b5d4c3e21".into()),
                cwd: Some(r"C:\dev\app".into()),
                running: true,
            })
        );
        let Layout::Split {
            ratios: inner,
            children: column,
            ..
        } = &children[1]
        else {
            panic!("the inner split");
        };
        assert_eq!(inner, &[0.3, 0.7]);
        let Layout::Panel(shell) = &column[0] else {
            panic!("a panel");
        };
        assert_eq!(shell.title.as_deref(), Some("Build"));
        assert_eq!(terminal(&column[0]).profile.as_deref(), Some("cmd"));
        assert_eq!(terminal(&column[1]), &TerminalContent::default());
        let tree = &doc.workspaces[1];
        assert_eq!(tree.main.as_deref(), Some("w-app"));
        let codex = terminal(tree.tabs[0].layout.as_ref().unwrap());
        let codex_agent = codex.agent.as_ref().unwrap();
        assert_eq!(codex_agent.session, None);
        assert!(!codex_agent.running);
        assert_eq!(
            doc.panel_ids().len(),
            4,
            "every panel survives: {:?}",
            doc.panel_ids()
        );
    }

    #[test]
    fn n03_a_migrated_file_saves_as_v2_and_reads_back_the_same() {
        let doc = parse(V1_FILE.as_bytes()).unwrap().document;
        let text = serde_json::to_string(&doc).unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["version"], 2);
        let leaf = &value["workspaces"][1]["tabs"][0]["layout"];
        assert_eq!(leaf["kind"], "panel");
        assert_eq!(leaf["content"]["kind"], "terminal");
        assert_eq!(leaf["content"]["agent"]["agent"], "codex");
        assert!(leaf.get("agent").is_none() && leaf.get("cwd").is_none());
        let again = parse(text.as_bytes()).unwrap();
        assert_eq!(again.from, 2);
        assert_eq!(again.document, doc);
    }

    #[test]
    fn n03_an_unknown_panel_kind_round_trips_untouched() {
        let text = r#"{"version":2,"active":"w1","workspaces":[{"id":"w1","tabs":[{"id":"t1",
            "layout":{"kind":"split","id":"s1","direction":"row","ratios":[0.5,0.5],"children":[
              {"kind":"panel","id":"p1","content":{"kind":"terminal"}},
              {"kind":"panel","id":"p2","title":"Board","content":{"kind":"plugin.board",
                "columns":["todo","done"],"nested":{"deep":[1,2.5,null]},"since":3}}]}}]}]}"#;
        let doc = parse(text.as_bytes()).unwrap().document;
        let Some(Layout::Split { children, .. }) = &doc.workspaces[0].tabs[0].layout else {
            panic!("the split");
        };
        let Layout::Panel(board) = &children[1] else {
            panic!("a panel");
        };
        let PanelContent::Unknown(unknown) = &board.content else {
            panic!("an unknown kind");
        };
        assert_eq!(board.content.kind(), "plugin.board");
        assert_eq!(unknown.fields.len(), 3);
        // Only terminals have sessions.
        assert_eq!(
            doc.terminal_ids(),
            std::collections::HashSet::from(["p1".to_owned()])
        );
        let saved: Value = serde_json::to_value(&doc).unwrap();
        let original: Value = serde_json::from_str(text).unwrap();
        let content = |v: &Value| v["workspaces"][0]["tabs"][0]["layout"]["children"][1].clone();
        assert_eq!(content(&saved), content(&original));
        assert_eq!(
            serde_json::from_value::<Document>(saved).unwrap(),
            doc,
            "reads back the same"
        );
    }

    #[test]
    fn n03_a_terminal_with_bad_fields_or_a_content_without_kind_is_damaged() {
        let bad_terminal = r#"{"version":2,"workspaces":[{"id":"w1","tabs":[{"id":"t1",
            "layout":{"kind":"panel","id":"p1","content":{"kind":"terminal","cwd":7}}}]}]}"#;
        assert!(parse(bad_terminal.as_bytes()).is_none());
        let no_kind = r#"{"version":2,"workspaces":[{"id":"w1","tabs":[{"id":"t1",
            "layout":{"kind":"panel","id":"p1","content":{"cwd":"C:\\"}}}]}]}"#;
        assert!(parse(no_kind.as_bytes()).is_none());
        // A newer format is never migrated here.
        assert!(parse(br#"{"version":3,"workspaces":[]}"#).is_none());
        assert_eq!(version_of(br#"{"version":3}"#), Some(3));
    }
}
