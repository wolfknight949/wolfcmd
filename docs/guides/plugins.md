# Writing a plugin agent

> Status: Current · N-09 ([design](../design/N-09-plugins.md))

A plugin adds agent CLIs to the Agents menu. It is a folder with one file, `plugin.toml`, that declares data; WolfCmd never runs code from it.

## Where
`%APPDATA%\WolfCmd\plugins\<id>\plugin.toml` (`WolfCmd-dev` for a debug build). Create the `plugins` folder if it isn't there. The folder's name is the plugin's `id`: lowercase letters, digits and `-`.

## Example
`%APPDATA%\WolfCmd\plugins\my-tools\plugin.toml`, for a CLI called `mycli`:

```toml
id = "my-tools"
name = "My tools"
version = "1.0.0"
description = "The agents I use"

[[agents]]
id = "mycli"
name = "My CLI"
order = 35          # among the built-ins: Claude Code 10, Codex 20, Gemini 30, Copilot 40, Aider 50, OpenCode 60
command = "mycli"   # what is typed to start it
detect = ["mycli"]  # installed when this program is on PATH or in a shim folder
color = 1           # 1-8, the workspace palette
fallback = "mycli --continue"  # what a restored panel types (only if mycli has such a flag)
```

Open the Agents menu: the agent is listed (its tooltip names the plugin). Edits show the next time the menu opens; no restart.

## Fields of an agent
The same as the built-in agents in `resources/agents/*.toml`; read those for verified examples.

| Field | Meaning |
|---|---|
| `id`, `name`, `order`, `command`, `detect` | Required. `id` follows the folder-name rule and must not be a built-in's |
| `locations` | Full paths where its installer puts it when it isn't on PATH; `%VAR%` expanded, `*` within one name |
| `color`, `install`, `docs` | Look, and the install hint shown (never run) while it is missing |
| `resume`, `fallback` | Resume a known session (`{session_id}`), and continue without one |
| `session_id`, `resume_or_new` | Arguments that give a new session WolfCmd's ID (`{session}`); resume-or-new for a never-saved session. Only when the CLI really supports it |
| `resume_pick` | The CLI's session picker, for a second restored panel in the same folder |
| `remote_control` | Arguments added when Remote Control is on (`{name}`) |
| `image_paste` | The key that makes the CLI read a pasted image (`alt+v`, `ctrl+v`) |
| `working_title` | N-06: a regex the terminal title matches while the CLI works (its own spinner in the title, e.g. `'^[◐◑] '`). Once matched, the title alone says working or idle; without it WolfCmd goes by output activity. A pattern that doesn't compile skips the agent |

Check each flag against the CLI's `--help` before you add it.

## Rules
- A plugin agent can't replace a built-in one: an agent with a built-in's id (or another plugin's) is skipped. Copy the built-in under a new id instead.
- Unknown fields are refused, so a typo is reported instead of ignored.
- Problems never stop WolfCmd: the Agents menu shows "1 plugin has a problem" at the bottom; its tooltip says which plugin and what is wrong. The other plugins and agents still load.
- To remove a plugin, delete its folder.
