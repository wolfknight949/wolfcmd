# N-09: Plugins, first contribution point: agents

> Status: Implemented · [Roadmap](../ROADMAP.md) N-09: a plugin system, so agents WolfCmd doesn't ship open from the Agents menu like the built-in ones

## Goal
A user (or a tool vendor) adds an agent CLI WolfCmd doesn't ship by dropping a folder into WolfCmd's data folder; the agent shows in the Agents menu and opens in a terminal panel like a built-in one. Small and clean: one contribution point (agents), more only when users ask.

## Model
- A plugin is a folder `<data dir>/plugins/<id>/` with a manifest `plugin.toml`:
  - `id` (equal to the folder's name; lowercase letters, digits and `-`, at most 64), `name`, `version` (text), optional `description`.
  - `[[agents]]`: each entry has exactly the fields of a built-in `resources/agents/*.toml` (`id`, `name`, `order`, `command`, `detect`, `locations`, `color`, `install`, `docs`, `session_id`, `resume`, `fallback`, `resume_or_new`, `resume_pick`, `remote_control`, `image_paste`). Unknown fields are refused, never half-read.
- `<data dir>` is `%APPDATA%\WolfCmd` (`WolfCmd-dev` in debug builds, `WOLFCMD_DATA_DIR` in tests). WolfCmd doesn't create the `plugins` folder; a missing folder means no plugins.
- Nothing is persisted by WolfCmd: plugins are the user's files, read only.

## Rules
- **Problems are reported, not fatal.** A folder without `plugin.toml`, a manifest that doesn't parse (the TOML parser's message), a manifest whose `id` isn't its folder's name, or a missing name or version skips that plugin. One bad `[[agents]]` entry (missing or unknown field, an id outside the rule, an empty `command` or `detect`, a `color` outside 1–8) skips that entry; the plugin's other agents load. Each problem names the plugin's folder and says what is wrong.
- **Ids are never shared, so nothing is replaced silently.** A plugin agent with a built-in's id is skipped and reported ("a built-in agent has this id; a plugin can't replace it"). Two plugins with the same agent id: the plugin whose folder name sorts first keeps it, the other is reported. To change a built-in, a plugin declares a copy under its own id (`claude-code-yolo`). This keeps a panel's saved `agent` id meaning one thing, and a downloaded plugin can't take over `claude-code`.
- **Order:** `order` places agents among the built-ins; equal values keep built-ins first, then plugin folder order. The menu still lists installed agents first.
- **Privacy:** plugins only declare data. WolfCmd never runs plugin code: detection is file checks (PATH, the shim folders, the entry's `locations`), and the agent's `command` is typed into a terminal only when the user opens that agent (or its panel is restored), quoted exactly like a built-in's. Nothing goes to the network.

## Reloading: when the menu opens, never polled
The registry reads the plugins folder again only when it changed, and only when asked:
- `AgentRegistry::current()` takes the folder's fingerprint (one directory listing, one file check of each `plugin.toml`: modified time and size) and compares it with the last read; equal means the last parsed list is handed out (an `Arc`), different means one new read. `agent_list` and `agent_command` both call it.
- The UI calls `agent_list` at its first need and again each time the Agents menu opens, so a plugin added, edited or removed shows on the next open, without a restart.
- Chosen over a file watcher (`notify` with a debounce): a watcher is a new dependency and a thread holding an OS watch on a folder for the whole run, for a folder that changes a few times in its life. The menu-open check costs a few file checks on a user action and nothing while idle, so it follows "nothing polls while idle" with less code. The cost: a change shows at the next menu open, not the instant it is saved, which is when the user looks anyway. No `agents_reload` command is needed: opening the menu is the reload.

## Core
- `wcmd-agents`: `plugins.rs` (the manifest, the fingerprint, reading a folder into plugins and problems, the id rule) and `AgentRegistry` in `registry.rs` (`new(Option<plugins dir>)`, `current() -> Arc<Agents>`; `Agents { list: Vec<Listed { agent, source: Source::{Builtin, Plugin { id, name }} }>, problems: Vec<PluginProblem { plugin, message }> }`, `Agents::find(id)`).
  - Simpler than an `Arc<dyn AgentSource>` trait object: there is one source of extra agents (the folder), so the registry holds its path; a trait comes with a second source.
  - Replaces the global `set_agent_source` / `merge_agents` / `all_agents` / `find_agent` (no caller, couldn't reload, replaced built-ins silently).
- `wcmd-app`: the registry is Tauri state (`ipc::agents::registry(data dir)`).
- IPC: `agent_list() -> AgentList { agents: AgentInfo[] (+ plugin: string | null, the plugin's name), problems: PluginProblem[] }`; `agent_command` finds the agent in the same registry.

## UI
- `core/agents.ts`: `agentList()` (cached), `reloadAgents()`, `listAgents()` (the agents only, unchanged for the terminal panel), pure `pluginProblemsLine(problems)`: "1 plugin has a problem" / "N plugins have problems" and one line per problem for the tooltip.
- `chrome/AgentsMenu.tsx`: reloads on open; a plugin agent's item has the tooltip "From the plugin <name>"; the problems line is a dimmed item in its own last section with the details as its tooltip. No new styles.

## Tests
- Rust (`wcmd-agents`, temp folders): a plugin loads (source, order, fields); a broken manifest is reported and the rest loads (syntax, missing field, unknown field, id ≠ folder, folder without a manifest, bad entries next to a good one); an id collision never replaces an agent (built-in id refused, the first plugin keeps a shared id); removing a plugin removes its agents; the registry reads again only when the folder changed (same `Arc`, a read counter). `wcmd-app`: `agent_list`'s mapping (plugin name, problems) and `agent_command` for a plugin agent.
- TS: `pluginProblemsLine` (none, one plugin with two problems, two plugins).

## Open questions
- None blocking. Later, when users ask: a plugin's own folder for files (icons), enabling and disabling plugins in settings, more contribution points (shell profiles, themes).

## As built
- The problems line reads "has a problem" rather than "couldn't be read": a plugin with one bad entry still loads its other agents.
- `AgentInfo.plugin` carries the plugin's name (shown), not its id.
