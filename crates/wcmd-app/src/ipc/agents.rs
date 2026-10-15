//! `agent` domain (N-06): the agents the Agents button lists (N-09: with the plugins' agents
//! and what in the plugins folder couldn't be used), and the line a terminal panel types to
//! start or resume one.

use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{Manager as _, State, WebviewWindow};
use tauri_specta::Event as _;
use wcmd_agents::{AgentRegistry, Agents, LaunchShell, Source, Start};
use wcmd_pty::ShellKind;

use crate::error::{ErrorKind, WcmdError};
use crate::ipc::pty::Host;
use crate::ipc::settings::SettingsService;
use crate::platform;

/// N-09: the registry in the app's state: the built-in agents and the plugins in
/// `<data dir>/plugins` (read when the agents are asked for, never watched).
pub(crate) fn registry(data_dir: &Path) -> Arc<AgentRegistry> {
    Arc::new(AgentRegistry::new(Some(data_dir.join("plugins"))))
}

/// An agent the user can open.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentInfo {
    pub(crate) id: String,
    pub(crate) name: String,
    /// Found on PATH or where its installers put it.
    pub(crate) installed: bool,
    /// Its color, an index into the workspace palette (1–8).
    pub(crate) color: u8,
    /// WolfCmd can pick its session ID at start, so a restored panel resumes exactly it.
    pub(crate) takes_session_id: bool,
    /// How to install it when it's missing (shown and copied, never run).
    pub(crate) install: Option<String>,
    /// Its install page.
    pub(crate) docs: Option<String>,
    /// N-02: the key that makes it attach the clipboard's image (`alt+v`, `ctrl+v`), which a
    /// paste of a picture into its panel presses; `None`: an image paste does nothing there.
    pub(crate) image_paste: Option<String>,
    /// N-09: the name of the plugin that declares it; `None`: built into WolfCmd.
    pub(crate) plugin: Option<String>,
}

/// N-09: something in the plugins folder that couldn't be used (skipped; the rest loads).
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginProblem {
    /// The plugin's folder name.
    pub(crate) plugin: String,
    /// What is wrong, for the user.
    pub(crate) message: String,
}

/// The Agents menu's content.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentList {
    /// Installed ones first, each group in registry order.
    pub(crate) agents: Vec<AgentInfo>,
    pub(crate) problems: Vec<PluginProblem>,
}

/// The agents and the plugin problems. N-09: the plugins folder is read again only when it
/// changed since the last call (the UI calls this when the Agents menu opens; nothing watches
/// or polls the folder).
#[tauri::command]
#[specta::specta]
pub(crate) async fn agent_list(
    registry: State<'_, Arc<AgentRegistry>>,
) -> Result<AgentList, WcmdError> {
    let registry = Arc::clone(&registry);
    tauri::async_runtime::spawn_blocking(move || list(&registry.current()))
        .await
        .map_err(|e| WcmdError::internal("listing the agents was interrupted", &e))
}

fn list(agents: &Agents) -> AgentList {
    let mut list: Vec<AgentInfo> = agents
        .list
        .iter()
        .map(|listed| {
            let agent = &listed.agent;
            AgentInfo {
                installed: agent.installed(),
                takes_session_id: !agent.session_id.is_empty(),
                id: agent.id.clone(),
                name: agent.name.clone(),
                color: agent.color,
                install: agent.install.clone(),
                docs: agent.docs.clone(),
                image_paste: agent.image_paste.clone(),
                plugin: match &listed.source {
                    Source::Builtin => None,
                    Source::Plugin { name, .. } => Some(name.clone()),
                },
            }
        })
        .collect();
    list.sort_by_key(|a| !a.installed);
    AgentList {
        agents: list,
        problems: agents
            .problems
            .iter()
            .map(|p| PluginProblem {
                plugin: p.plugin.clone(),
                message: p.message.clone(),
            })
            .collect(),
    }
}

/// How the panel starts its agent.
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum AgentStart {
    /// A new session, with the ID WolfCmd picked for it (agents that take one).
    New { session: Option<String> },
    /// A restored panel: its session (started anew with that ID when the agent never saved
    /// it), else the agent's latest one in the folder.
    Resume { session: Option<String> },
    /// N-06: a restored panel without a session, when another restored panel of the same agent
    /// in the same folder already continues the latest one: the agent's own session picker (a
    /// new session when it has none), so two panels never continue one session.
    Pick,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentCommandArgs {
    pub(crate) agent: String,
    pub(crate) start: AgentStart,
    /// The panel's shell profile (`None`: the default shell), so an agent outside PATH is
    /// typed by its full path quoted for that shell.
    #[serde(default)]
    pub(crate) profile: Option<String>,
    /// The Remote Control session name, when the panel's workspace folder (or the setting) turns
    /// it on.
    #[serde(default)]
    pub(crate) remote_control: Option<String>,
}

/// The line to type into the panel's shell.
#[tauri::command]
#[specta::specta]
pub(crate) async fn agent_command(
    registry: State<'_, Arc<AgentRegistry>>,
    host: State<'_, Host>,
    args: AgentCommandArgs,
) -> Result<String, WcmdError> {
    let registry = Arc::clone(&registry);
    let host = Arc::clone(&host);
    tauri::async_runtime::spawn_blocking(move || {
        // N-07: no profile: the default shell (the setting).
        let profile = args
            .profile
            .clone()
            .unwrap_or_else(|| host.default_profile().id);
        command_line(&registry.current(), &args, &profile)
    })
    .await
    .map_err(|e| WcmdError::internal("the agent command was interrupted", &e))?
}

/// The agent's line for `args`, quoted for the shell of `profile`.
fn command_line(
    agents: &Agents,
    args: &AgentCommandArgs,
    profile: &str,
) -> Result<String, WcmdError> {
    let agent = agents.find(&args.agent).ok_or_else(|| {
        WcmdError::new(
            ErrorKind::NotFound,
            format!("no agent {} in this WolfCmd", args.agent),
        )
    })?;
    let how = match &args.start {
        AgentStart::New { session } => Start::New {
            session: session.as_deref(),
        },
        AgentStart::Resume { session } => Start::Resume {
            session: session.as_deref(),
        },
        AgentStart::Pick => Start::Pick,
    };
    Ok(agent.start_line(launch_shell(profile), how, args.remote_control.as_deref()))
}

/// How the profile's shell takes a quoted full path. Unknown shells (WSL, custom) type the
/// agent by name.
fn launch_shell(profile: &str) -> LaunchShell {
    match wcmd_pty::find_profile(profile).and_then(|p| p.shell) {
        Some(ShellKind::PowerShell) => LaunchShell::PowerShell,
        Some(ShellKind::Cmd) => LaunchShell::Cmd,
        Some(ShellKind::Bash) => LaunchShell::Bash,
        Some(ShellKind::Wsl) | None => LaunchShell::Other,
    }
}

/// N-06: a panel's agent started or stopped working (`session/activity.rs`). Sent only on a
/// change; `pty_open` carries the state for a view that attaches later.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentActivity {
    pub(crate) panel_id: String,
    pub(crate) working: bool,
}

/// N-06: an agent's own working title, by its id, when it starts (for the session host).
pub(crate) fn title_patterns(registry: &Arc<AgentRegistry>) -> crate::session::TitlePatterns {
    let registry = Arc::clone(registry);
    Box::new(move |agent: &str| {
        registry
            .current()
            .find(agent)
            .and_then(wcmd_agents::Agent::title_pattern)
    })
}

/// N-06: the session host's activity changes, sent to the page as `AgentActivity` events (also
/// for panels nobody shows).
pub(crate) fn activity_events(app: tauri::AppHandle) -> crate::session::ActivitySink {
    Box::new(move |panel: &str, working: bool| {
        let change = AgentActivity {
            panel_id: panel.to_owned(),
            working,
        };
        if let Err(error) = change.emit(&app) {
            tracing::warn!(%error, "N-06: could not send an agent activity change");
        }
    })
}

/// N-06: the user clicked the "finished" notification of this panel's agent: show it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShowPanel {
    pub(crate) panel_id: String,
}

/// N-06: an agent finished while the user wasn't looking. Only names: never terminal content.
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentDoneArgs {
    pub(crate) panel_id: String,
    /// The agent's name ("Claude Code").
    pub(crate) agent: String,
    /// The tab's name.
    pub(crate) tab: String,
}

/// The notification's title and line.
fn done_text(args: &AgentDoneArgs) -> (String, String) {
    (
        format!("{} finished", args.agent),
        format!("in {}", args.tab),
    )
}

/// N-06: an agent finished while the window wasn't in front: its taskbar button flashes until
/// the window comes forward, and with `agents.notify_when_done` a system notification says so;
/// clicking it brings the window forward and shows the panel (`ShowPanel`). Nothing while the
/// window is in front.
#[tauri::command]
#[specta::specta]
pub(crate) fn agent_done(
    window: WebviewWindow,
    settings: State<'_, Arc<SettingsService>>,
    args: AgentDoneArgs,
) -> Result<(), WcmdError> {
    if window.is_focused()? {
        return Ok(());
    }
    if let Err(error) = platform::flash_taskbar(&window) {
        tracing::warn!(%error, "N-06: the taskbar button did not flash");
    }
    if !settings.agents().notify_when_done {
        return Ok(());
    }
    let (title, body) = done_text(&args);
    let identifier = window.config().identifier.clone();
    let target = window.clone();
    let panel_id = args.panel_id;
    let shown = platform::notify(&identifier, &title, &body, move || {
        let window = target.clone();
        let panel_id = panel_id.clone();
        // The click arrives on a system thread; the window is moved on its own.
        let _ = target.run_on_main_thread(move || {
            if let Err(error) = crate::tray::show(&window) {
                tracing::warn!(%error, "N-06: could not bring the window forward");
            }
            let _ = ShowPanel { panel_id }.emit(&window);
        });
    });
    if let Err(error) = shown {
        tracing::warn!(%error, "N-06: the notification did not show");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The built-in agents (no plugins folder).
    fn agents() -> Arc<Agents> {
        AgentRegistry::new(None).current()
    }

    #[test]
    fn n09_plugin_agents_are_listed_with_their_plugin_and_problems() {
        let dir = std::env::temp_dir().join(format!("wcmd n09 ipc {}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("extra")).unwrap();
        std::fs::create_dir_all(dir.join("broken")).unwrap();
        std::fs::write(
            dir.join("extra").join("plugin.toml"),
            "id = \"extra\"\nname = \"Extra agents\"\nversion = \"1.0.0\"\n\n[[agents]]\nid = \
             \"wcmd-n09-stand-in\"\nname = \"Stand-in\"\norder = 90\ncommand = \
             \"wcmd-n09-stand-in\"\ndetect = [\"wcmd-n09-stand-in\"]\n",
        )
        .unwrap();
        std::fs::write(dir.join("broken").join("plugin.toml"), "id = ").unwrap();
        let registry = AgentRegistry::new(Some(dir.clone()));
        let listed = list(&registry.current());
        let extra = listed
            .agents
            .iter()
            .find(|a| a.id == "wcmd-n09-stand-in")
            .unwrap();
        assert_eq!(extra.plugin.as_deref(), Some("Extra agents"));
        assert!(!extra.installed);
        let codex = listed.agents.iter().find(|a| a.id == "codex").unwrap();
        assert_eq!(codex.plugin, None);
        assert_eq!(listed.problems.len(), 1);
        assert_eq!(listed.problems[0].plugin, "broken");
        // The agent's line comes from the same registry.
        let mut start = args(AgentStart::New { session: None }, None);
        start.agent = "wcmd-n09-stand-in".into();
        assert_eq!(
            command_line(&registry.current(), &start, "cmd").unwrap(),
            "wcmd-n09-stand-in"
        );
        let value = serde_json::to_value(&listed.problems[0]).unwrap();
        assert!(value.get("message").is_some() && value.get("plugin").is_some());
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn args(start: AgentStart, remote: Option<&str>) -> AgentCommandArgs {
        AgentCommandArgs {
            agent: "claude-code".into(),
            start,
            profile: None,
            remote_control: remote.map(Into::into),
        }
    }

    #[test]
    fn n06_new_resumed_and_remote_control_lines() {
        let id = "0b9e3c4a-1d2e-4f5a-8b6c-7d8e9f0a1b2c";
        let new = command_line(
            &agents(),
            &args(
                AgentStart::New {
                    session: Some(id.into()),
                },
                None,
            ),
            "cmd",
        )
        .unwrap();
        assert!(new.ends_with(&format!("--session-id {id}")), "{new}");
        let resumed = command_line(
            &agents(),
            &args(
                AgentStart::Resume {
                    session: Some(id.into()),
                },
                Some("wolfcmd"),
            ),
            "cmd",
        )
        .unwrap();
        // Started anew with the same ID when the agent never saved it (N-06).
        assert!(
            resumed.contains(&format!("--resume {id} --remote-control wolfcmd")),
            "{resumed}"
        );
        assert!(
            resumed.contains(&format!("--session-id {id} --remote-control wolfcmd")),
            "{resumed}"
        );
        // A restored panel without its session continues the latest one in the folder.
        let fallback = command_line(
            &agents(),
            &args(AgentStart::Resume { session: None }, None),
            "cmd",
        )
        .unwrap();
        assert!(fallback.ends_with("--continue"), "{fallback}");
    }

    #[test]
    fn n06_a_second_panel_without_a_session_opens_the_picker() {
        let pick = |agent: &str| {
            let mut pick = args(AgentStart::Pick, None);
            pick.agent = agent.into();
            command_line(&agents(), &pick, "cmd").unwrap()
        };
        // codex-cli 0.162 `codex resume --help`: "picker by default".
        // (Typed by name or by full path, whatever this machine has.)
        let codex = pick("codex");
        assert!(codex.ends_with(" resume"), "{codex}");
        assert!(pick("claude-code").ends_with(" --resume"));
        // No picker: a new session, never the same one twice.
        assert!(!pick("gemini").contains("resume"));
        let value = serde_json::json!({ "kind": "pick" });
        assert!(matches!(
            serde_json::from_value::<AgentStart>(value).unwrap(),
            AgentStart::Pick
        ));
    }

    #[test]
    fn n06_an_unknown_agent_is_refused() {
        let mut unknown = args(AgentStart::New { session: None }, None);
        unknown.agent = "nope".into();
        assert_eq!(
            command_line(&agents(), &unknown, "cmd").unwrap_err().kind,
            ErrorKind::NotFound
        );
    }
}
