# wcmd-agents

**Purpose:** the AI agent CLIs WolfCmd knows (N-06): the registry (built-in agents and the agents N-09 plugins declare), where each one is installed, and the exact line that starts or resumes it in a panel's shell. Pure logic: no windows, no terminals, no network. WolfCmd only opens a terminal and types the line; it does not run an agent harness.

## Public API
- `Agent` (fields: `id`, `name`, `order`, `command`, `detect`, `locations`, `color`, `install`, `docs`, `session_id`, `resume`, `fallback`, `resume_or_new`, `resume_pick`, `remote_control`, `image_paste`, N-06 `working_title`), `Agent::installed()`, N-06 `Agent::title_pattern() -> Option<TitlePattern>` (`TitlePattern::new`, `working(title)`; size-limited regex), `Agent::start_line(shell, Start, remote_control) -> String` with `Start::{New { session }, Resume { session }, Pick}`; `LaunchShell` (PowerShell, Cmd, Bash, Other).
- N-09: `AgentRegistry::new(Option<plugins dir>)`, `current() -> Arc<Agents>`; `Agents { list: Vec<Listed { agent, source }>, problems: Vec<PluginProblem { plugin, message }> }`, `Agents::find(id)`; `Source::{Builtin, Plugin { id, name }}`.

## Layout
- `src/registry.rs`: `Agent`, the embedded built-ins, `AgentRegistry` and the merge (ids never shared).
- `src/plugins.rs`: `plugin.toml` (`id` = folder name, `name`, `version`, optional `description`, `[[agents]]`), the folder fingerprint, reading plugins into agents and problems, the id rule.
- `src/launch.rs`: start lines and quoting. `src/locate.rs`: finding the executable (PATH, shim folders, `locations`).

## Invariants
- Built-in agents are data: `resources/agents/*.toml`, embedded at compile time. Add an agent by adding a file and listing it in `registry.rs`; never branch on an agent's id in code.
- N-09 plugins only declare data; nothing in a plugin is run. A `plugin.toml` over 256 KiB is a problem, never read whole. A plugin entry has exactly a built-in's fields (unknown ones refused). Problems are reported (`Agents::problems`) and skipped, never fatal. A plugin agent never replaces another agent: a built-in's id or an id an earlier plugin (by folder name) has is refused and reported.
- N-09 the plugins folder is read again only when its fingerprint (the listing, each `plugin.toml`'s modified time and size) changed, and only when `current()` is called (the UI asks when the Agents menu opens). Nothing watches or polls it.
- Everything typed into a shell is one argument at a time, quoted for that shell, or left out (`quote_arg`). Session IDs are typed only when plain (letters, digits, `-_.`, at most 128 characters).
- Detection looks at files and PATH only, never starts a process.
- An agent without `session_id` args can't be given an ID: a restored panel continues with its `fallback`; when another restored panel of that agent already continues the latest session in the folder, the UI asks for `Start::Pick` (its `resume_pick`, else a new session).
- `resume_or_new` (N-06): a restored panel types `resume` and, only when that fails, a new session with the same ID (`a || b`; PowerShell `a; if (-not $?) { b }`). Only for agents whose resume of an unsaved session and new session with a used ID both fail (verified per agent, quoted in its TOML); never a look at the agent's own files.
- Flags in the TOMLs were verified against the agent's `--help`; keep that comment when changing one.
- N-06 `working_title` patterns were read in each agent's own code (quoted in its TOML) and are tested with recorded titles (`n06_working_titles_match_what_each_agent_shows`); a plugin's pattern that doesn't compile skips the agent.

## Testing
`cargo test -p wcmd-agents`. `Agent::start_line` is tested through `start_line_at` with a fixed location, so tests don't depend on what is installed on the machine. N-09 tests write plugins into their own temp folders (never the real data folder); `n09_the_guides_example_loads` parses the example in `docs/guides/plugins.md`.
