# ADR-0001: A lean terminal with workspaces, built around the core's sessions

> Status: Accepted · 2026-10-14 · Related: [ADR-0002](0002-winget-distribution.md) (distribution), [ADR-0003](0003-panel-content-by-kind.md) (panel contents), [ADR-0004](0004-open-source-and-releases.md) (open source, releases)

## Context
WolfCmd is a terminal for Windows (macOS and Linux later) meant to be a good home for AI coding agents. Most of the time one works with one agent in one or two terminals, and that should feel fast, calm and native. The app grows slowly, from user feedback: a terminal and workspaces (like Wave Terminal), a plugin system, and support for many agent CLIs. Agents run for hours: a hang, a reload or a crash must never cost the user a session or a layout.

## Decision
- **Lean scope.** The terminal and workspaces come first, judged by the one-or-two-terminal feel. A feature is added only when users ask for it; nothing in the tree is unused (knip and clippy `-D warnings` in `pnpm check`).
- **Stack.** Tauri 2 with a Rust core (`crates/*`), a React 19 + TypeScript UI (`packages/*`), xterm.js (WebGL, DOM fallback), pnpm and Cargo workspaces. Shells run under ConPTY (`portable-pty`, patched, with Microsoft's ConPTY bundled). The core's Rust types are the contract: the TypeScript bindings are generated.
- **The model: workspaces → tabs → tiled panels**, as in Wave Terminal. A workspace (optionally tied to a folder) holds tabs, shown as pills in the title bar; a tab is tiled panels. No sidebar: the workspace name at the top left opens the switcher.
- **The core owns the sessions.** One shell per terminal panel lives in the core, not in the page. The core mirrors each terminal's VT state (`wcmd-term`), so a reloaded or remounted view reattaches with a replay, and the scrollback can be saved. Output goes from the IPC channel straight into xterm, never through React state; a page never ends a terminal.
- **Crash-safe saving.** The UI owns the live workspace document and sends every change; the core writes it at once with an atomic file replace, keeps backups, and never overwrites a file it couldn't read (the run is read-only instead). Persisted formats are versioned: every change needs a version bump, a migration and a test.
- **Registries, not switches.** Panel types, the right bar's items, the Add flyout's entries and the agents are registered; core code never branches on a kind or an agent's id.
- **A plugin system for agents.** A plugin is a folder with a `plugin.toml` that declares data (agent CLIs, shaped like the built-in ones); WolfCmd never runs plugin code. More contribution points come when users ask.
- **Agents are terminals.** An agent opens as a terminal panel running its CLI; WolfCmd types the line that starts or resumes it and watches the terminal itself (no harness, no hooks).
- **User data** lives in `%APPDATA%\WolfCmd` (`WolfCmd-dev` for debug builds) in WolfCmd's own formats, starting at version 1. An earlier data folder of a different format found there (one with `state.db` and no `workspaces.json`) is set aside as `<name>.old`, never deleted.
- Feature IDs are `N-xx`.

## Alternatives considered
- **A broad feature set from the start** (workflows, boards, extra panel types, suggestions): rejected; each feature must earn its place through user feedback.
- **Shells owned by the page:** rejected; a reload or a hung WebView would end every terminal and agent.
- **Plugins that run code:** rejected for now; declared data covers agents and can't harm the user's machine.

## Consequences
- The docs are short and describe only what exists; module rules live in each module's `CLAUDE.md` (contributor notes, read by people and coding agents alike).
- Every persisted-format change carries a migration and a test with a real file of the older format.
- A separate session host process (shells outliving the core) fits later behind the same attach-by-panel API.
