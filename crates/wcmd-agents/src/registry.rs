//! The agent registry. Built-in entries are `resources/agents/*.toml`, embedded in the binary;
//! N-09 plugins add entries with the same fields ([`AgentRegistry`]).

use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use serde::Deserialize;

use crate::launch::with_args;
use crate::locate::{LaunchShell, Location, locate_here, with_program};
use crate::plugins::{Fingerprint, Plugin, PluginProblem, fingerprint, read_plugins};

/// One agent CLI.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Agent {
    /// Stable, e.g. `claude-code`.
    pub id: String,
    pub name: String,
    /// Display order (lower first).
    pub order: u32,
    /// What to type to start it.
    pub command: String,
    /// Executable names (without extension) whose presence means it is installed: on PATH,
    /// or in a package manager's shim folder.
    pub detect: Vec<String>,
    /// Where its installers put it when it isn't on PATH. `%VAR%` is expanded and `*` matches
    /// within one folder or file name; the newest match wins.
    #[serde(default)]
    pub locations: Vec<String>,
    /// Its color in the UI, an index into the workspace palette (1-8).
    #[serde(default = "default_color")]
    pub color: u8,
    /// How to install it, shown (never run) when it is missing, e.g.
    /// `winget install Anthropic.ClaudeCode`.
    #[serde(default)]
    pub install: Option<String>,
    /// Its install page.
    #[serde(default)]
    pub docs: Option<String>,
    /// Arguments that start a new session with an ID WolfCmd chose, `{session}` being the ID
    /// (`["--session-id", "{session}"]`). Empty: the agent can't be given an ID, so its
    /// sessions are resumed with `fallback`.
    #[serde(default)]
    pub session_id: Vec<String>,
    /// Resumes a known session; `{session_id}` is replaced.
    #[serde(default)]
    pub resume: Option<String>,
    /// Resumes without a known session (e.g. "continue the last one").
    #[serde(default)]
    pub fallback: Option<String>,
    /// N-06: resuming a session the agent never saved fails (non-zero exit), and starting a new
    /// session with an ID the agent already has in that folder fails too. A restored panel then
    /// types `resume`, and when that fails, a new session with the same ID (`session_id`):
    /// exactly one of them runs, whether or not the agent saved the session before WolfCmd
    /// closed, without looking at the agent's own files. Needs `resume` and `session_id`.
    #[serde(default)]
    pub resume_or_new: bool,
    /// Starts the agent on its own list of earlier sessions to pick one from (`claude
    /// --resume`, `codex resume`). Typed as is. N-06: a restored panel without a session opens
    /// it when another panel of the agent already continues the latest session in the folder;
    /// `None` (or blank): a new session there.
    #[serde(default)]
    pub resume_pick: Option<String>,
    /// Added to every start line (new, resumed or picked session) when the user turned
    /// Remote Control on for the panel's project (`["--remote-control", "{name}"]`), `{name}`
    /// being the session's name. Empty: the agent has no such launch option.
    #[serde(default)]
    pub remote_control: Vec<String>,
    /// The key the agent reads an image from the clipboard with in its terminal on
    /// Windows (`alt+v`, `ctrl+v`: a modifier, `+`, one letter). Pasting an image (no text in
    /// the clipboard) into its panel presses it, so the agent attaches the image itself. `None`:
    /// an image paste does nothing there.
    #[serde(default)]
    pub image_paste: Option<String>,
    /// N-06: a regex the terminal title matches while the agent works (its own spinner in the
    /// title, e.g. `^[◐◑] `). Once it matched, the title alone says working or idle; `None`:
    /// output activity only. Verified per agent, quoted in its TOML.
    #[serde(default)]
    pub working_title: Option<String>,
}

fn default_color() -> u8 {
    8
}

/// N-06: an agent's `working_title`, compiled.
#[derive(Debug, Clone)]
pub struct TitlePattern(regex::Regex);

impl TitlePattern {
    /// The pattern, or the regex error. Size-limited: a plugin's pattern can't grow huge.
    pub fn new(pattern: &str) -> Result<Self, String> {
        regex::RegexBuilder::new(pattern)
            .size_limit(64 * 1024)
            .build()
            .map(Self)
            .map_err(|e| e.to_string())
    }

    /// Whether `title` says the agent works.
    pub fn working(&self, title: &str) -> bool {
        self.0.is_match(title)
    }
}

/// Whether `id` can be typed on a command line as is: letters, digits, `-`, `_`, `.`, not
/// empty, at most 128 characters (a UUID always is).
pub(crate) fn safe_session(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

impl Agent {
    /// Where its executable is: on PATH, or a full path (file checks only).
    pub(crate) fn locate(&self) -> Option<Location> {
        locate_here(&self.detect, &self.locations)
    }

    /// Whether it was found (also outside PATH).
    pub fn installed(&self) -> bool {
        self.locate().is_some()
    }

    /// `command` ready to type in `shell`: by name when the agent is on PATH (or wasn't
    /// found), else by its quoted full path.
    pub(crate) fn launch_line_at(
        location: Option<&Location>,
        command: &str,
        shell: LaunchShell,
    ) -> String {
        match location {
            Some(Location::File(path)) => with_program(command, path, shell),
            _ => command.to_owned(),
        }
    }

    /// N-06: its `working_title`, compiled; `None` without one (or when it doesn't compile:
    /// plugins are checked at load, built-ins by a test).
    pub fn title_pattern(&self) -> Option<TitlePattern> {
        let pattern = self.working_title.as_deref()?.trim();
        if pattern.is_empty() {
            return None;
        }
        TitlePattern::new(pattern).ok()
    }

    /// Whether `resume_command(Some(id))` resumes `id` (not the fallback).
    pub(crate) fn resumes(&self, id: &str) -> bool {
        self.resume.is_some() && safe_session(id)
    }

    /// Whether a new session can be given the ID `id` (`with_session_id` adds it).
    pub(crate) fn takes_id(&self, id: &str) -> bool {
        !self.session_id.is_empty() && safe_session(id)
    }

    /// The command that brings the agent back: its session when known (and the ID is safe to
    /// put on a command line), else the fallback, else a fresh start.
    pub(crate) fn resume_command(&self, session_id: Option<&str>) -> String {
        match (&self.resume, session_id) {
            (Some(template), Some(id)) if self.resumes(id) => template.replace("{session_id}", id),
            _ => self
                .fallback
                .clone()
                .unwrap_or_else(|| self.command.clone()),
        }
    }

    /// The agent's session picker command, `None` when it has none (or it is blank).
    pub(crate) fn pick_command(&self) -> Option<&str> {
        self.resume_pick
            .as_deref()
            .map(str::trim)
            .filter(|command| !command.is_empty())
    }

    /// `line` with the agent's Remote Control arguments, `{name}` filled with `name`
    /// (each quoted for `shell`). An agent without them, or a name a shell can't take safely,
    /// leaves the line: the agent starts without Remote Control.
    pub(crate) fn with_remote_control(&self, line: &str, name: &str, shell: LaunchShell) -> String {
        let args: Vec<String> = self
            .remote_control
            .iter()
            .map(|arg| arg.replace("{name}", name))
            .collect();
        with_args(line, &args, shell)
    }

    /// N-06: `line` with the arguments that give a new session the ID `session`. Unchanged
    /// when the agent can't be given one, or the ID is not plain (never typed half-quoted).
    pub(crate) fn with_session_id(&self, line: &str, session: &str, shell: LaunchShell) -> String {
        if !self.takes_id(session) {
            return line.to_owned();
        }
        let args: Vec<String> = self
            .session_id
            .iter()
            .map(|arg| arg.replace("{session}", session))
            .collect();
        with_args(line, &args, shell)
    }
}

const BUILTIN: &[&str] = &[
    include_str!("../../../resources/agents/claude-code.toml"),
    include_str!("../../../resources/agents/codex.toml"),
    include_str!("../../../resources/agents/gemini.toml"),
    include_str!("../../../resources/agents/copilot.toml"),
    include_str!("../../../resources/agents/aider.toml"),
    include_str!("../../../resources/agents/opencode.toml"),
];

/// The built-in agents, in display order. Parsed once.
pub(crate) fn builtin_agents() -> &'static [Agent] {
    static AGENTS: OnceLock<Vec<Agent>> = OnceLock::new();
    AGENTS.get_or_init(|| {
        let mut agents: Vec<Agent> = BUILTIN
            .iter()
            .filter_map(|text| toml::from_str::<Agent>(text).ok())
            .collect();
        agents.sort_by_key(|a| a.order);
        agents
    })
}

/// One plugin's `[[agents]]` entry (the fields of a built-in TOML; unknown ones refused).
pub(crate) fn parse_agent_value(value: toml::Value) -> Result<Agent, String> {
    value
        .try_into::<Agent>()
        .map_err(|e| e.message().to_owned())
}

/// N-09: where an agent comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    /// `resources/agents/*.toml`.
    Builtin,
    /// A plugin in the plugins folder: its id (the folder's name) and its name.
    Plugin { id: String, name: String },
}

/// An agent and where it comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listed {
    pub agent: Agent,
    pub source: Source,
}

/// N-09: every agent at one moment, built-in and from plugins, in display order (`order`,
/// then built-ins before plugins, then plugin folder order), and what in the plugins folder
/// couldn't be used.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Agents {
    pub list: Vec<Listed>,
    pub problems: Vec<PluginProblem>,
}

impl Agents {
    /// The agent with this id.
    pub fn find(&self, id: &str) -> Option<&Agent> {
        self.list
            .iter()
            .map(|listed| &listed.agent)
            .find(|agent| agent.id == id)
    }

    /// The built-ins with the plugins' agents added. Ids are never shared: a plugin agent
    /// with a built-in's id, or with an id an earlier plugin (by folder name) already has, is
    /// skipped and reported, so nothing replaces an agent silently.
    fn merge(builtins: &[Agent], plugins: Vec<Plugin>, mut problems: Vec<PluginProblem>) -> Self {
        let mut list: Vec<Listed> = builtins
            .iter()
            .map(|agent| Listed {
                agent: agent.clone(),
                source: Source::Builtin,
            })
            .collect();
        for plugin in plugins {
            for agent in plugin.agents {
                if let Some(taken) = list.iter().find(|listed| listed.agent.id == agent.id) {
                    let message = match &taken.source {
                        Source::Builtin => format!(
                            "agent `{}`: a built-in agent has this id; a plugin can't replace \
                             it (give the agent its own id)",
                            agent.id
                        ),
                        Source::Plugin { id, .. } => format!(
                            "agent `{}`: the plugin `{id}` already has an agent with this id",
                            agent.id
                        ),
                    };
                    problems.push(PluginProblem {
                        plugin: plugin.id.clone(),
                        message,
                    });
                    continue;
                }
                list.push(Listed {
                    agent,
                    source: Source::Plugin {
                        id: plugin.id.clone(),
                        name: plugin.name.clone(),
                    },
                });
            }
        }
        // A stable sort: equal `order`s keep built-ins first, then plugin folder order.
        list.sort_by_key(|listed| listed.agent.order);
        Self { list, problems }
    }
}

/// N-09: the agents WolfCmd offers, kept in the app's state. The plugins folder is read again
/// only when it changed: [`AgentRegistry::current`] compares the folder's fingerprint (a
/// listing and one file check per plugin) with the last one, and nothing runs in between.
#[derive(Debug)]
pub struct AgentRegistry {
    /// `<data dir>/plugins`; `None`: built-in agents only.
    plugins: Option<PathBuf>,
    /// The last read, and the fingerprint it was read at.
    loaded: Mutex<Option<(Fingerprint, Arc<Agents>)>>,
    /// How many times the plugins were read (tests).
    #[cfg(test)]
    reads: std::sync::atomic::AtomicUsize,
}

impl AgentRegistry {
    /// The built-in agents and the plugins in `plugins` (the folder may not exist yet).
    pub fn new(plugins: Option<PathBuf>) -> Self {
        Self {
            plugins,
            loaded: Mutex::new(None),
            #[cfg(test)]
            reads: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    /// The agents now: the last read when the plugins folder didn't change since, else a new
    /// read. Concurrent callers wait for one read.
    pub fn current(&self) -> Arc<Agents> {
        let print = self.plugins.as_deref().map(fingerprint).unwrap_or_default();
        let mut loaded = self.loaded.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some((seen, agents)) = loaded.as_ref()
            && *seen == print
        {
            return Arc::clone(agents);
        }
        #[cfg(test)]
        self.reads
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let (plugins, problems) = match &self.plugins {
            Some(dir) => read_plugins(dir, &print),
            None => (Vec::new(), Vec::new()),
        };
        let agents = Arc::new(Agents::merge(builtin_agents(), plugins, problems));
        *loaded = Some((print, Arc::clone(&agents)));
        agents
    }

    #[cfg(test)]
    fn reads(&self) -> usize {
        self.reads.load(std::sync::atomic::Ordering::Relaxed)
    }
}

/// A built-in agent by id (tests).
#[cfg(test)]
pub(crate) fn builtin(id: &str) -> Agent {
    builtin_agents()
        .iter()
        .find(|a| a.id == id)
        .cloned()
        .unwrap_or_else(|| panic!("no built-in agent {id}"))
}

/// An agent from TOML text shaped like a plugin's `[[agents]]` entry (tests).
#[cfg(test)]
pub(crate) fn agent_from(text: &str) -> Agent {
    parse_agent_value(toml::from_str(text).unwrap()).unwrap()
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    #[test]
    fn every_builtin_entry_parses_in_order() {
        let ids: Vec<&str> = builtin_agents().iter().map(|a| a.id.as_str()).collect();
        assert_eq!(BUILTIN.len(), ids.len(), "an entry failed to parse");
        assert_eq!(
            ids,
            [
                "claude-code",
                "codex",
                "gemini",
                "copilot",
                "aider",
                "opencode"
            ]
        );
        for text in BUILTIN {
            toml::from_str::<Agent>(text).unwrap();
        }
        // Every agent has a command to type and something to detect it by, and an id a
        // plugin's would be held to.
        for agent in builtin_agents() {
            assert!(agent.command.starts_with(&agent.detect[0]), "{}", agent.id);
            assert!(crate::plugins::valid_id(&agent.id), "{}", agent.id);
        }
    }

    #[test]
    fn n06_install_hints_are_shown_data() {
        let claude = builtin("claude-code");
        assert_eq!(
            claude.install.as_deref(),
            Some("winget install Anthropic.ClaudeCode")
        );
        for agent in builtin_agents() {
            if let Some(docs) = &agent.docs {
                assert!(docs.starts_with("https://"), "{}", agent.id);
            }
        }
    }

    #[test]
    fn resume_uses_the_session_else_the_fallback() {
        let claude = builtin("claude-code");
        assert_eq!(
            claude.resume_command(Some("3f2a-11b0_x.1")),
            "claude --resume 3f2a-11b0_x.1"
        );
        assert_eq!(claude.resume_command(None), "claude --continue");
        // A session ID that could inject a command is never typed.
        assert_eq!(
            claude.resume_command(Some("x; rm -rf ~")),
            "claude --continue"
        );
        let gemini = builtin("gemini");
        assert_eq!(gemini.resume_command(Some("abc")), "gemini");
    }

    #[test]
    fn image_paste_keys_are_agent_data() {
        // Claude Code 2.1.292 binds image paste to Alt+V on Windows (Ctrl+V elsewhere); Codex
        // 0.162 says "Paste an image with `Ctrl+V`".
        let key = |id: &str| builtin(id).image_paste;
        assert_eq!(key("claude-code").as_deref(), Some("alt+v"));
        assert_eq!(key("codex").as_deref(), Some("ctrl+v"));
        assert_eq!(key("aider"), None);
        // Every key is a modifier and one letter: the UI only knows how to press those.
        for agent in builtin_agents() {
            if let Some(key) = &agent.image_paste {
                let (modifier, letter) = key.split_once('+').unwrap();
                assert!(matches!(modifier, "alt" | "ctrl"), "{}: {key}", agent.id);
                assert!(
                    letter.len() == 1 && letter.chars().all(|c| c.is_ascii_lowercase()),
                    "{}: {key}",
                    agent.id
                );
            }
        }
    }

    #[test]
    fn session_pickers_are_agent_data() {
        // Verified 2026-10-12: Claude Code 2.1.292 `--help`: "-r, --resume [value] Resume a
        // conversation by session ID, or open interactive picker"; codex-cli 0.162 `codex
        // resume --help`: "picker by default"; Copilot CLI 1.0.95 `--help`: "-r, --resume
        // [<value>]" (value optional).
        let pick = |id: &str| builtin(id).pick_command().map(str::to_owned);
        assert_eq!(pick("claude-code").as_deref(), Some("claude --resume"));
        assert_eq!(pick("codex").as_deref(), Some("codex resume"));
        assert_eq!(pick("copilot").as_deref(), Some("copilot --resume"));
        // Agents whose flags weren't verified have none.
        for id in ["gemini", "aider", "opencode"] {
            assert_eq!(pick(id), None, "{id}");
        }
        // Every built-in's picker starts the agent's own program and needs no session ID.
        for agent in builtin_agents() {
            if let Some(command) = agent.pick_command() {
                assert!(
                    command.starts_with(&agent.command),
                    "{}: {command}",
                    agent.id
                );
                assert!(!command.contains('{'), "{}: {command}", agent.id);
            }
        }
        // Blank means none.
        let x = agent_from(
            r#"id = "x"
name = "X"
order = 90
command = "x"
detect = ["x"]
resume_pick = "  ""#,
        );
        assert_eq!(x.pick_command(), None);
    }

    #[test]
    fn codex_and_copilot_resume() {
        let codex = builtin("codex");
        assert_eq!(
            codex.resume_command(Some("0199a213-81c0-7800-8aa1-bbab2a035a53")),
            "codex resume 0199a213-81c0-7800-8aa1-bbab2a035a53"
        );
        assert_eq!(codex.resume_command(None), "codex resume --last");
        let copilot = builtin("copilot");
        assert_eq!(copilot.resume_command(Some("s-1")), "copilot --resume s-1");
        assert_eq!(copilot.resume_command(None), "copilot --continue");
        // Every agent has its own color, and the three big ones look beyond PATH.
        let mut colors: Vec<u8> = builtin_agents().iter().map(|a| a.color).collect();
        colors.sort_unstable();
        colors.dedup();
        assert_eq!(colors.len(), builtin_agents().len());
        assert!(colors.iter().all(|c| (1..=8).contains(c)));
        for id in ["claude-code", "codex", "copilot"] {
            assert!(!builtin(id).locations.is_empty(), "{id}");
        }
    }

    #[test]
    fn remote_control_is_agent_data_with_a_quoted_name() {
        let claude = builtin("claude-code");
        assert_eq!(
            claude.with_remote_control("claude", "wolfcmd · main", LaunchShell::PowerShell),
            "claude --remote-control 'wolfcmd · main'"
        );
        assert_eq!(
            claude.with_remote_control("claude --resume abc", "wolfcmd", LaunchShell::Cmd),
            "claude --resume abc --remote-control wolfcmd"
        );
        // A name a shell can't take safely: the agent starts without Remote Control.
        assert_eq!(
            claude.with_remote_control("claude", "a\"b", LaunchShell::PowerShell),
            "claude"
        );
        // Codex's remote control is a daemon, not a launch flag: its line never changes.
        let codex = builtin("codex");
        assert_eq!(codex.remote_control.len(), 0);
        assert_eq!(
            codex.with_remote_control("codex", "wolfcmd", LaunchShell::Bash),
            "codex"
        );
    }

    #[test]
    fn n06_only_claude_code_takes_a_session_id_from_wolfcmd() {
        // Verified with Claude Code 2.1.292 `claude --help`: "--session-id <uuid> Use a
        // specific session ID for the conversation (must be a valid UUID)".
        let claude = builtin("claude-code");
        assert_eq!(claude.session_id, ["--session-id", "{session}"]);
        for agent in builtin_agents().iter().filter(|a| a.id != "claude-code") {
            assert!(agent.session_id.is_empty(), "{}", agent.id);
        }
        for agent in builtin_agents() {
            for arg in &agent.session_id {
                assert!(!arg.contains("{session_id}"), "{}", agent.id);
            }
        }
    }

    #[test]
    fn n06_session_ids_are_only_typed_when_plain() {
        for id in [
            "3f2a1c9e-0b1d-4f6a-8c2e-9a7b5d4c3e21",
            "abc_1.2-x",
            &"a".repeat(128),
        ] {
            assert!(safe_session(id), "{id}");
        }
        for id in ["", "x y", "x;rm", "a\nb", "$(x)", &"a".repeat(129)] {
            assert!(!safe_session(id), "{id}");
        }
    }

    // N-09: plugins, each test in its own temp folder (never the real data folder).

    /// A fresh, empty plugins folder for one test.
    fn plugins_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wcmd n09 {name} {}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_plugin(dir: &Path, folder: &str, manifest: &str) {
        std::fs::create_dir_all(dir.join(folder)).unwrap();
        std::fs::write(dir.join(folder).join("plugin.toml"), manifest).unwrap();
    }

    fn manifest(id: &str, agents: &str) -> String {
        format!("id = \"{id}\"\nname = \"Plugin {id}\"\nversion = \"1.0.0\"\n{agents}")
    }

    fn agent_entry(id: &str, order: u32) -> String {
        format!(
            "\n[[agents]]\nid = \"{id}\"\nname = \"Agent {id}\"\norder = {order}\ncommand = \
             \"{id}\"\ndetect = [\"{id}\"]\n"
        )
    }

    fn ids(agents: &Agents) -> Vec<&str> {
        agents.list.iter().map(|l| l.agent.id.as_str()).collect()
    }

    #[test]
    fn n09_without_plugins_the_builtins_are_listed() {
        let missing = std::env::temp_dir().join(format!("wcmd n09 none {}", std::process::id()));
        for registry in [AgentRegistry::new(None), AgentRegistry::new(Some(missing))] {
            let agents = registry.current();
            assert_eq!(agents.list.len(), builtin_agents().len());
            assert_eq!(agents.problems, []);
            assert!(agents.list.iter().all(|l| l.source == Source::Builtin));
            assert_eq!(agents.find("codex").unwrap().command, "codex");
        }
    }

    #[test]
    fn n09_a_plugin_loads_its_agents_in_display_order() {
        let dir = plugins_dir("loads");
        write_plugin(
            &dir,
            "cursor",
            &(manifest("cursor", "description = \"Cursor's CLI\"")
                + &agent_entry("cursor-agent", 35)
                + "color = 5\nresume_pick = \"cursor-agent resume\"\nimage_paste = \"ctrl+v\"\n"),
        );
        let registry = AgentRegistry::new(Some(dir.clone()));
        let agents = registry.current();
        assert_eq!(agents.problems, []);
        assert_eq!(
            ids(&agents),
            [
                "claude-code",
                "codex",
                "gemini",
                "cursor-agent",
                "copilot",
                "aider",
                "opencode"
            ]
        );
        let listed = agents
            .list
            .iter()
            .find(|l| l.agent.id == "cursor-agent")
            .unwrap();
        assert_eq!(
            listed.source,
            Source::Plugin {
                id: "cursor".into(),
                name: "Plugin cursor".into()
            }
        );
        assert_eq!(listed.agent.color, 5);
        assert_eq!(listed.agent.pick_command(), Some("cursor-agent resume"));
        assert_eq!(listed.agent.image_paste.as_deref(), Some("ctrl+v"));
        assert!(agents.find("cursor-agent").is_some());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn n09_a_broken_manifest_is_reported_and_the_rest_loads() {
        let dir = plugins_dir("broken");
        write_plugin(
            &dir,
            "good",
            &(manifest("good", "") + &agent_entry("good-agent", 90)),
        );
        write_plugin(&dir, "syntax", "id = \"syntax\"\nname = ");
        write_plugin(&dir, "missing", "id = \"missing\"\nname = \"No version\"\n");
        write_plugin(&dir, "renamed", &manifest("other", ""));
        write_plugin(&dir, "odd", &(manifest("odd", "") + "homepage = \"x\"\n"));
        std::fs::create_dir_all(dir.join("empty")).unwrap();
        // One bad entry is skipped, the plugin's other agents load.
        write_plugin(
            &dir,
            "mixed",
            &(manifest("mixed", "")
                + &agent_entry("fine", 91)
                + "\n[[agents]]\nid = \"no-command\"\nname = \"X\"\norder = 92\ndetect = [\"x\"]\n"
                + &agent_entry("modes", 93)
                + "modes = []\n"
                + &agent_entry("Bad_Id", 94)
                + &agent_entry("pale", 95)
                + "color = 12\n"),
        );
        let agents = AgentRegistry::new(Some(dir.clone())).current();
        assert!(agents.find("good-agent").is_some());
        assert!(agents.find("fine").is_some());
        for id in ["no-command", "modes", "Bad_Id", "pale"] {
            assert!(agents.find(id).is_none(), "{id}");
        }
        let problems: Vec<(&str, &str)> = agents
            .problems
            .iter()
            .map(|p| (p.plugin.as_str(), p.message.as_str()))
            .collect();
        let of = |plugin: &str| {
            problems
                .iter()
                .filter(|(p, _)| *p == plugin)
                .map(|(_, m)| *m)
                .collect::<Vec<_>>()
        };
        assert_eq!(of("good"), [] as [&str; 0]);
        assert!(of("syntax")[0].starts_with("plugin.toml: "), "{problems:?}");
        assert!(of("missing")[0].contains("version"), "{problems:?}");
        assert!(
            of("renamed")[0].contains("name of its folder"),
            "{problems:?}"
        );
        assert!(of("odd")[0].contains("homepage"), "{problems:?}");
        assert_eq!(of("empty"), ["no plugin.toml in this folder"]);
        let mixed = of("mixed");
        assert_eq!(mixed.len(), 4, "{mixed:?}");
        assert!(mixed[0].starts_with("agent `no-command`: ") && mixed[0].contains("command"));
        assert!(mixed[1].starts_with("agent `modes`: ") && mixed[1].contains("modes"));
        assert!(mixed[2].starts_with("agent `Bad_Id`: the id can only"));
        assert!(mixed[3].starts_with("agent `pale`: `color`"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// N-06: titles recorded from each agent's own code (see its TOML): what it shows while it
    /// works, and what it shows otherwise.
    #[test]
    fn n06_working_titles_match_what_each_agent_shows() {
        let working = |id: &str, title: &str| {
            builtin(id)
                .title_pattern()
                .unwrap_or_else(|| panic!("{id} has a working_title"))
                .working(title)
        };
        // Claude Code 2.1.292: ◐ / ◑ every 960 ms while busy, ✳ when idle.
        for title in ["\u{25d0} Claude Code", "\u{25d1} Fix the login bug"] {
            assert!(working("claude-code", title), "{title}");
        }
        for title in [
            "\u{2733} Claude Code",
            "\u{2733} Fix the login bug",
            "claude",
            "Command Prompt - claude --session-id 1",
            "",
        ] {
            assert!(!working("claude-code", title), "{title}");
        }
        // Codex: a Braille spinner frame as the title's activity item (first by default).
        for title in [
            "\u{280b} Fix the tests | wolfcmd",
            "wolfcmd \u{2839} Working",
            "\u{280f}",
        ] {
            assert!(working("codex", title), "{title}");
        }
        for title in ["Fix the tests | wolfcmd", "Action Required", "codex", ""] {
            assert!(!working("codex", title), "{title}");
        }
        // Gemini CLI: ✦ responding, ⏲ working silently; ◇ Ready, ✋ Action Required.
        for title in [
            "\u{2726}  Working\u{2026}",
            "\u{23f2}  Working\u{2026} (wolfcmd)",
        ] {
            assert!(working("gemini", title), "{title}");
        }
        for title in [
            "\u{25c7}  Ready (wolfcmd)",
            "\u{270b}  Action Required (wolfcmd)",
            "Gemini CLI (wolfcmd)",
        ] {
            assert!(!working("gemini", title), "{title}");
        }
        // The others have none verified: output activity only.
        for id in ["copilot", "aider", "opencode"] {
            assert!(builtin(id).title_pattern().is_none(), "{id}");
        }
    }

    #[test]
    fn n06_a_plugin_agents_working_title_must_compile() {
        let dir = plugins_dir("titles");
        write_plugin(
            &dir,
            "titles",
            &(manifest("titles", "")
                + &agent_entry("spins", 96)
                + "working_title = '^[|/\\\\-] '\n"
                + &agent_entry("broken", 97)
                + "working_title = '^[◐'\n"),
        );
        let agents = AgentRegistry::new(Some(dir.clone())).current();
        let spins = agents.find("spins").unwrap().title_pattern().unwrap();
        assert!(spins.working("/ busy") && !spins.working("done"));
        assert!(agents.find("broken").is_none());
        assert!(
            agents.problems[0]
                .message
                .starts_with("agent `broken`: `working_title` is not a valid regex"),
            "{:?}",
            agents.problems
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn n09_an_id_collision_never_replaces_an_agent() {
        let dir = plugins_dir("collision");
        // A built-in's id: refused, the built-in stays.
        write_plugin(
            &dir,
            "a-plugin",
            &(manifest("a-plugin", "") + &agent_entry("codex", 1) + &agent_entry("shared", 90)),
        );
        // An id an earlier plugin (by folder name) has: the earlier one keeps it.
        write_plugin(
            &dir,
            "b-plugin",
            &(manifest("b-plugin", "") + &agent_entry("shared", 91)),
        );
        let agents = AgentRegistry::new(Some(dir.clone())).current();
        let codex: Vec<&Listed> = agents
            .list
            .iter()
            .filter(|l| l.agent.id == "codex")
            .collect();
        assert_eq!(codex.len(), 1);
        assert_eq!(codex[0].source, Source::Builtin);
        assert_eq!(codex[0].agent, builtin("codex"));
        let shared: Vec<&Listed> = agents
            .list
            .iter()
            .filter(|l| l.agent.id == "shared")
            .collect();
        assert_eq!(shared.len(), 1);
        assert!(matches!(&shared[0].source, Source::Plugin { id, .. } if id == "a-plugin"));
        assert_eq!(
            agents.problems,
            [
                PluginProblem {
                    plugin: "a-plugin".into(),
                    message: "agent `codex`: a built-in agent has this id; a plugin can't \
                              replace it (give the agent its own id)"
                        .into()
                },
                PluginProblem {
                    plugin: "b-plugin".into(),
                    message: "agent `shared`: the plugin `a-plugin` already has an agent with \
                              this id"
                        .into()
                }
            ]
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn n09_removing_a_plugin_removes_its_agents() {
        let dir = plugins_dir("remove");
        write_plugin(
            &dir,
            "extra",
            &(manifest("extra", "") + &agent_entry("extra-agent", 90)),
        );
        let registry = AgentRegistry::new(Some(dir.clone()));
        assert!(registry.current().find("extra-agent").is_some());
        std::fs::remove_dir_all(dir.join("extra")).unwrap();
        let agents = registry.current();
        assert!(agents.find("extra-agent").is_none());
        assert_eq!(agents.list.len(), builtin_agents().len());
        // The whole folder gone: built-ins only.
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(registry.current().list.len(), builtin_agents().len());
    }

    #[test]
    fn n09_the_registry_reads_again_only_when_the_folder_changed() {
        let dir = plugins_dir("reread");
        write_plugin(
            &dir,
            "one",
            &(manifest("one", "") + &agent_entry("one-agent", 90)),
        );
        let registry = AgentRegistry::new(Some(dir.clone()));
        let first = registry.current();
        let second = registry.current();
        assert_eq!(registry.reads(), 1);
        assert!(Arc::ptr_eq(&first, &second), "the same read is handed out");
        // A changed manifest (another size) is read again.
        write_plugin(
            &dir,
            "one",
            &(manifest("one", "") + &agent_entry("one-agent", 90) + "color = 4\n"),
        );
        assert_eq!(registry.current().find("one-agent").unwrap().color, 4);
        assert_eq!(registry.reads(), 2);
        // A new plugin folder is read too; then nothing changes again.
        write_plugin(
            &dir,
            "two",
            &(manifest("two", "") + &agent_entry("two-agent", 91)),
        );
        assert!(registry.current().find("two-agent").is_some());
        registry.current();
        assert_eq!(registry.reads(), 3);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
