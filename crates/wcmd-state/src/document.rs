//! N-03 / N-04: the workspace document, the Wave model. A workspace (a
//! name and an optional folder) holds tabs; a tab is a layout of tiled panels: splits whose
//! leaves are panels. N-03 panel types (format 2): a panel is an ID, a title and its content,
//! whose `kind` says what it is. A terminal is the one kind this WolfCmd knows (an agent panel
//! is a terminal that started an agent, N-06); any other kind (a newer WolfCmd's, a plugin's)
//! is kept as it is and saved back the same.

use std::collections::HashSet;

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};

/// The document's format (1: the first format, ADR-0001; 2: N-03 panel types, a panel's content
/// tagged by its kind). A change needs a migration step in `migrate.rs` and a test.
pub const CURRENT_VERSION: u32 = 2;
/// The smallest share a split gives one of its children.
pub const MIN_RATIO: f64 = 0.05;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub version: u32,
    pub workspaces: Vec<Workspace>,
    /// The workspace shown.
    #[serde(default)]
    pub active: Option<String>,
}

impl Default for Document {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            workspaces: Vec::new(),
            active: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    /// The user's name; empty: named after its folder.
    #[serde(default)]
    pub name: String,
    /// N-04: the folder new terminals start in (`None`: the shell's default).
    #[serde(default)]
    pub folder: Option<String>,
    pub tabs: Vec<Tab>,
    /// The tab shown.
    #[serde(default)]
    pub active_tab: Option<String>,
    /// N-10: this workspace is a git worktree of the repository whose main workspace has this
    /// ID (its `folder` is the worktree's path). `None`: a plain workspace.
    #[serde(default)]
    pub main: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Tab {
    pub id: String,
    /// The user's name; empty: "Tab N".
    #[serde(default)]
    pub name: String,
    /// `None`: an empty tab (no panel yet).
    #[serde(default)]
    pub layout: Option<Layout>,
    /// The focused panel.
    #[serde(default)]
    pub focused: Option<String>,
    /// N-03: the panel that fills the tab (maximized); the others stay, hidden. `None`: the
    /// tiled layout. Files without it (written by older versions): `None`.
    #[serde(default)]
    pub maximized: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    /// Children side by side.
    Row,
    /// Children one above the other.
    Column,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Layout {
    #[serde(rename_all = "camelCase")]
    Split {
        id: String,
        direction: Direction,
        children: Vec<Layout>,
        /// One share per child, summing to 1.
        ratios: Vec<f64>,
    },
    Panel(Panel),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Panel {
    pub id: String,
    /// The user's title; `None`: the one its content gives (a program's, a shell's).
    #[serde(default)]
    pub title: Option<String>,
    /// N-03: what the panel shows, tagged by its `kind`.
    pub content: PanelContent,
}

impl Panel {
    /// A terminal panel.
    pub fn terminal(id: impl Into<String>, content: TerminalContent) -> Self {
        Self {
            id: id.into(),
            title: None,
            content: PanelContent::Terminal(content),
        }
    }
}

/// The `kind` of a terminal panel's content.
pub const TERMINAL_KIND: &str = "terminal";

/// N-03: a panel's content: one object whose `kind` names the panel type (`terminal`). A kind
/// this WolfCmd doesn't know is [`PanelContent::Unknown`] and round-trips with every field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(untagged)]
pub enum PanelContent {
    Terminal(TerminalContent),
    Unknown(UnknownContent),
}

impl PanelContent {
    /// The panel type's name (`terminal`, or the unknown kind's own).
    pub fn kind(&self) -> &str {
        match self {
            Self::Terminal(_) => TERMINAL_KIND,
            Self::Unknown(unknown) => &unknown.kind,
        }
    }

    /// The terminal's fields; `None` for other kinds.
    pub fn terminal(&self) -> Option<&TerminalContent> {
        match self {
            Self::Terminal(terminal) => Some(terminal),
            Self::Unknown(_) => None,
        }
    }
}

/// The `kind` is read first: `terminal` must be a valid terminal (a damaged one is an error, as
/// in format 1), any other kind is kept whole.
impl<'de> Deserialize<'de> for PanelContent {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        match value.get("kind").and_then(serde_json::Value::as_str) {
            Some(TERMINAL_KIND) => serde_json::from_value(value)
                .map(Self::Terminal)
                .map_err(D::Error::custom),
            Some(_) => serde_json::from_value(value)
                .map(Self::Unknown)
                .map_err(D::Error::custom),
            None => Err(D::Error::custom("a panel's content has no kind")),
        }
    }
}

/// N-03: a terminal panel: a shell, maybe running an agent. Only terminal panels have sessions.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalContent {
    pub kind: TerminalKind,
    /// The shell profile; `None`: the default shell.
    #[serde(default)]
    pub profile: Option<String>,
    /// The folder the shell last reported (N-05: it starts there again).
    #[serde(default)]
    pub cwd: Option<String>,
    /// N-06: the agent started in it.
    #[serde(default)]
    pub agent: Option<AgentRef>,
}

/// The `kind` of a [`TerminalContent`]: always `terminal`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub enum TerminalKind {
    #[default]
    #[serde(rename = "terminal")]
    Terminal,
}

/// N-03: the content of a panel type this WolfCmd doesn't know (a newer WolfCmd's, or a plugin's
/// that isn't installed): its kind, and every other field as it was.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
pub struct UnknownContent {
    pub kind: String,
    /// Everything else, untouched. The UI keeps it too: it never rebuilds a content it doesn't
    /// know, so the generated type leaves it out.
    #[serde(flatten)]
    #[specta(skip)]
    pub fields: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentRef {
    /// The agent's registry ID (`claude-code`, `codex`).
    pub agent: String,
    /// The session WolfCmd picked when it started the agent: a restored panel resumes it.
    #[serde(default)]
    pub session: Option<String>,
    /// N-06: the folder the agent was started in. Agents keep their sessions per folder, so a
    /// restored panel starts its shell here (not where the shell went later) to resume.
    #[serde(default)]
    pub cwd: Option<String>,
    /// N-06: the agent still runs in the panel. `false` once its command ended and the shell
    /// is back at a prompt (OSC 133): a restored panel is then a plain shell, and the agent is
    /// not started again. Files without it (written by older versions): `true`.
    #[serde(default = "still_running")]
    pub running: bool,
}

fn still_running() -> bool {
    true
}

impl Document {
    /// The document made consistent, whatever the file held: duplicate IDs dropped, splits with
    /// one child collapsed, ratios fixed, the shown workspace, tab and focused panel pointing at
    /// things that exist. A correct document comes back unchanged.
    #[must_use]
    pub fn normalized(mut self) -> Self {
        self.version = CURRENT_VERSION;
        let mut seen = HashSet::new();
        self.workspaces
            .retain(|w| !w.id.is_empty() && seen.insert(w.id.clone()));
        for workspace in &mut self.workspaces {
            workspace.folder = workspace.folder.take().filter(|f| !f.trim().is_empty());
            workspace
                .tabs
                .retain(|t| !t.id.is_empty() && seen.insert(t.id.clone()));
            for tab in &mut workspace.tabs {
                tab.layout = tab.layout.take().and_then(|l| l.normalized(&mut seen));
                let panels = tab
                    .layout
                    .as_ref()
                    .map(Layout::panel_ids)
                    .unwrap_or_default();
                if !tab.focused.as_ref().is_some_and(|id| panels.contains(id)) {
                    tab.focused = panels.first().cloned();
                }
                // N-03: a maximized panel that is gone leaves the tab tiled.
                if !tab.maximized.as_ref().is_some_and(|id| panels.contains(id)) {
                    tab.maximized = None;
                }
            }
            if !workspace
                .active_tab
                .as_ref()
                .is_some_and(|id| workspace.tabs.iter().any(|t| &t.id == id))
            {
                workspace.active_tab = workspace.tabs.first().map(|t| t.id.clone());
            }
        }
        if !self
            .active
            .as_ref()
            .is_some_and(|id| self.workspaces.iter().any(|w| &w.id == id))
        {
            self.active = self.workspaces.first().map(|w| w.id.clone());
        }
        self.repair_worktree_links();
        self
    }

    /// N-10: a worktree workspace's `main` points at a plain workspace: a link to itself, to a
    /// workspace that is gone or to another worktree is cleared (the workspace becomes plain).
    fn repair_worktree_links(&mut self) {
        let ids: HashSet<String> = self.workspaces.iter().map(|w| w.id.clone()).collect();
        for workspace in &mut self.workspaces {
            let id = workspace.id.clone();
            workspace.main = workspace
                .main
                .take()
                .filter(|main| *main != id && ids.contains(main));
        }
        let worktrees: HashSet<String> = self
            .workspaces
            .iter()
            .filter(|w| w.main.is_some())
            .map(|w| w.id.clone())
            .collect();
        for workspace in &mut self.workspaces {
            if workspace
                .main
                .as_ref()
                .is_some_and(|m| worktrees.contains(m))
            {
                workspace.main = None;
            }
        }
    }

    /// Every panel's ID (of any kind), in every workspace and tab.
    pub fn panel_ids(&self) -> HashSet<String> {
        self.panels().map(|p| p.id.clone()).collect()
    }

    /// N-03: the IDs of the terminal panels, the only ones with sessions.
    pub fn terminal_ids(&self) -> HashSet<String> {
        self.panels()
            .filter(|p| p.content.terminal().is_some())
            .map(|p| p.id.clone())
            .collect()
    }

    /// Every panel, in every workspace and tab.
    pub fn panels(&self) -> impl Iterator<Item = &Panel> {
        self.workspaces
            .iter()
            .flat_map(|w| &w.tabs)
            .filter_map(|t| t.layout.as_ref())
            .flat_map(Layout::panels)
    }
}

impl Layout {
    /// Every panel's ID, in reading order.
    pub fn panel_ids(&self) -> Vec<String> {
        self.panels().into_iter().map(|p| p.id.clone()).collect()
    }

    /// Every panel, in reading order.
    pub fn panels(&self) -> Vec<&Panel> {
        match self {
            Self::Split { children, .. } => children.iter().flat_map(Self::panels).collect(),
            Self::Panel(panel) => vec![panel],
        }
    }

    /// `None` when nothing is left (`seen`: the IDs used so far in the document).
    fn normalized(self, seen: &mut HashSet<String>) -> Option<Self> {
        match self {
            Self::Panel(panel) => (!panel.id.is_empty() && seen.insert(panel.id.clone()))
                .then_some(Self::Panel(panel)),
            Self::Split {
                id,
                direction,
                children,
                ratios,
            } => {
                // N-05: a split's ID names nothing else (focus and maximize name panels), so a
                // repeated one is renamed; dropping the split would drop its panels with it.
                let id = if seen.insert(id.clone()) {
                    id
                } else {
                    let fresh = (1..=seen.len() + 1)
                        .map(|n| format!("{id}#{n}"))
                        .find(|candidate| !seen.contains(candidate))
                        .unwrap_or_default();
                    seen.insert(fresh.clone());
                    fresh
                };
                let mut kept = Vec::new();
                let mut shares = Vec::new();
                for (index, child) in children.into_iter().enumerate() {
                    if let Some(child) = child.normalized(seen) {
                        kept.push(child);
                        shares.push(ratios.get(index).copied().unwrap_or(0.0));
                    }
                }
                match kept.len() {
                    0 => None,
                    1 => kept.pop(),
                    _ => Some(Self::Split {
                        id,
                        direction,
                        ratios: fixed_ratios(&shares),
                        children: kept,
                    }),
                }
            }
        }
    }
}

/// Shares that are finite, at least `MIN_RATIO` each and sum to 1 (equal when unusable).
fn fixed_ratios(shares: &[f64]) -> Vec<f64> {
    let usable = shares.iter().all(|s| s.is_finite() && *s > 0.0);
    let raw: Vec<f64> = if usable {
        shares.to_vec()
    } else {
        vec![1.0; shares.len()]
    };
    let total: f64 = raw.iter().sum();
    let clamped: Vec<f64> = raw.iter().map(|s| (s / total).max(MIN_RATIO)).collect();
    let total: f64 = clamped.iter().sum();
    clamped.iter().map(|s| s / total).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn panel(id: &str) -> Layout {
        Layout::Panel(Panel::terminal(id, TerminalContent::default()))
    }

    fn split(id: &str, children: Vec<Layout>, ratios: Vec<f64>) -> Layout {
        Layout::Split {
            id: id.into(),
            direction: Direction::Row,
            children,
            ratios,
        }
    }

    fn tab(id: &str, layout: Option<Layout>) -> Tab {
        Tab {
            id: id.into(),
            name: String::new(),
            layout,
            focused: None,
            maximized: None,
        }
    }

    fn workspace(id: &str, tabs: Vec<Tab>) -> Workspace {
        Workspace {
            id: id.into(),
            name: String::new(),
            folder: Some("c:/dev/app".into()),
            tabs,
            active_tab: None,
            main: None,
        }
    }

    #[test]
    fn n05_a_correct_document_comes_back_unchanged() {
        let doc = Document {
            version: CURRENT_VERSION,
            workspaces: vec![workspace(
                "w1",
                vec![tab(
                    "t1",
                    Some(split("s1", vec![panel("p1"), panel("p2")], vec![0.5, 0.5])),
                )],
            )],
            active: Some("w1".into()),
        };
        let mut expected = doc.clone();
        expected.workspaces[0].active_tab = Some("t1".into());
        expected.workspaces[0].tabs[0].focused = Some("p1".into());
        assert_eq!(doc.normalized(), expected);
    }

    #[test]
    fn n05_broken_parts_are_repaired_not_rejected() {
        let doc = Document {
            version: 0,
            workspaces: vec![
                workspace(
                    "w1",
                    vec![
                        tab(
                            "t1",
                            Some(split("s1", vec![panel("p1"), panel("p1")], vec![f64::NAN])),
                        ),
                        tab("t1", None),
                    ],
                ),
                workspace("w1", Vec::new()),
            ],
            active: Some("gone".into()),
        };
        let fixed = doc.normalized();
        assert_eq!(fixed.workspaces.len(), 1);
        assert_eq!(fixed.workspaces[0].tabs.len(), 1);
        assert_eq!(fixed.workspaces[0].tabs[0].layout, Some(panel("p1")));
        assert_eq!(fixed.workspaces[0].tabs[0].focused.as_deref(), Some("p1"));
        assert_eq!(fixed.workspaces[0].active_tab.as_deref(), Some("t1"));
        assert_eq!(fixed.active.as_deref(), Some("w1"));
        assert_eq!(fixed.panel_ids(), HashSet::from(["p1".to_owned()]));
    }

    #[test]
    fn n06_a_v1_agent_panel_without_cwd_and_running_loads_as_running() {
        let text = r#"{"version":1,"active":"w1","workspaces":[{"id":"w1","tabs":[{"id":"t1",
            "layout":{"kind":"panel","id":"p1","cwd":"C:\\dev\\app",
            "agent":{"agent":"claude-code","session":"3f2a1c9e-0b1d-4f6a-8c2e-9a7b5d4c3e21"}}}]}]}"#;
        let doc = crate::migrate::parse(text.as_bytes()).unwrap().document;
        let Some(Layout::Panel(panel)) = &doc.workspaces[0].tabs[0].layout else {
            panic!("a panel");
        };
        let agent = panel.content.terminal().unwrap().agent.as_ref().unwrap();
        assert!(agent.running);
        assert_eq!(agent.cwd, None);
        // Both are written from now on, and read back.
        let mut stopped = agent.clone();
        stopped.running = false;
        stopped.cwd = Some(r"C:\dev\app".into());
        let json = serde_json::to_value(&stopped).unwrap();
        assert_eq!(json["running"], false);
        assert_eq!(json["cwd"], r"C:\dev\app");
        assert_eq!(serde_json::from_value::<AgentRef>(json).unwrap(), stopped);
    }

    #[test]
    fn n03_a_file_without_maximized_loads_tiled_and_a_maximized_panel_round_trips() {
        let text = r#"{"version":1,"active":"w1","workspaces":[{"id":"w1","tabs":[{"id":"t1",
            "layout":{"kind":"panel","id":"p1"}}]}]}"#;
        let doc = crate::migrate::parse(text.as_bytes()).unwrap().document;
        assert_eq!(doc.workspaces[0].tabs[0].maximized, None);
        let mut maximized = tab(
            "t1",
            Some(split("s1", vec![panel("p1"), panel("p2")], vec![0.5, 0.5])),
        );
        maximized.maximized = Some("p2".into());
        let json = serde_json::to_value(&maximized).unwrap();
        assert_eq!(json["maximized"], "p2");
        assert_eq!(serde_json::from_value::<Tab>(json).unwrap(), maximized);
    }

    #[test]
    fn n03_a_maximized_panel_that_is_gone_is_cleared() {
        let mut kept = tab(
            "t1",
            Some(split("s1", vec![panel("p1"), panel("p2")], vec![0.5, 0.5])),
        );
        kept.maximized = Some("p2".into());
        let mut gone = tab("t2", Some(panel("p3")));
        gone.maximized = Some("nowhere".into());
        let doc = Document {
            version: 1,
            workspaces: vec![workspace("w1", vec![kept, gone])],
            active: Some("w1".into()),
        }
        .normalized();
        assert_eq!(doc.workspaces[0].tabs[0].maximized.as_deref(), Some("p2"));
        assert_eq!(doc.workspaces[0].tabs[1].maximized, None);
    }

    #[test]
    fn n10_a_file_without_main_loads_as_plain_workspaces() {
        let text = r#"{"version":1,"active":"w1","workspaces":[{"id":"w1",
            "folder":"C:\\dev\\app","tabs":[{"id":"t1"}]}]}"#;
        let doc: Document = serde_json::from_str(text).unwrap();
        assert_eq!(doc.workspaces[0].main, None);
        let mut worktree = workspace("w2", Vec::new());
        worktree.main = Some("w1".into());
        let json = serde_json::to_value(&worktree).unwrap();
        assert_eq!(json["main"], "w1");
        assert_eq!(serde_json::from_value::<Workspace>(json).unwrap(), worktree);
    }

    #[test]
    fn n10_main_links_to_missing_self_or_worktree_workspaces_are_cleared() {
        let linked = |id: &str, main: &str| {
            let mut w = workspace(id, vec![tab(&format!("t-{id}"), None)]);
            w.main = Some(main.into());
            w
        };
        let doc = Document {
            version: 1,
            workspaces: vec![
                workspace("main", vec![tab("t-main", None)]),
                linked("ok", "main"),
                linked("gone", "nowhere"),
                linked("self", "self"),
                linked("nested", "ok"),
            ],
            active: Some("main".into()),
        };
        let fixed = doc.normalized();
        let mains: Vec<Option<&str>> = fixed.workspaces.iter().map(|w| w.main.as_deref()).collect();
        assert_eq!(mains, vec![None, Some("main"), None, None, None]);
        // A repaired document comes back unchanged.
        assert_eq!(fixed.clone().normalized(), fixed);
    }

    #[test]
    fn n05_a_repeated_split_id_keeps_its_panels() {
        let left = split("s1", vec![panel("p1"), panel("p2")], vec![0.5, 0.5]);
        let right = split("s1", vec![panel("p3"), panel("p4")], vec![0.5, 0.5]);
        let doc = Document {
            version: 1,
            workspaces: vec![workspace(
                "w1",
                vec![tab(
                    "t1",
                    Some(split("s1", vec![left, right], vec![0.5, 0.5])),
                )],
            )],
            active: Some("w1".into()),
        };
        let fixed = doc.normalized();
        let layout = fixed.workspaces[0].tabs[0].layout.as_ref().unwrap();
        assert_eq!(layout.panel_ids(), ["p1", "p2", "p3", "p4"]);
        // A repaired document comes back unchanged.
        assert_eq!(fixed.clone().normalized(), fixed);
    }

    #[test]
    fn n03_ratios_are_kept_in_range() {
        assert_eq!(fixed_ratios(&[1.0, 1.0]), vec![0.5, 0.5]);
        let tiny = fixed_ratios(&[0.999, 0.001]);
        assert!(tiny[1] >= MIN_RATIO * 0.9);
        assert!((tiny.iter().sum::<f64>() - 1.0).abs() < 1e-9);
    }
}
