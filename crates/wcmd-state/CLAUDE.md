# wcmd-state

**Purpose:** the workspace document the UI edits and the files it is saved in: `workspaces.json` and `window.json`.

## Public API
- `Document { version, workspaces, active }`, `Workspace` (id, name, optional `folder`, `tabs`, `active_tab`, N-10 optional `main`: the ID of the main workspace of a git worktree workspace), `Tab` (id, name, `layout`, focused panel, N-03 optional `maximized`: the panel that fills the tab), `Layout` (`Split` with `Direction`, children and ratios; or a `Panel` leaf), `Panel` (id, title, N-03 `content: PanelContent`: `Terminal(TerminalContent { kind: "terminal", profile, cwd, optional AgentRef { agent, session, cwd, running } })` (the folder the agent started in, and whether it still runs; `running` defaults to `true`) or `Unknown(UnknownContent { kind, fields })`, any other kind kept whole; `Panel::terminal`, `PanelContent::kind` / `terminal`, `TERMINAL_KIND`), `MIN_RATIO`, `CURRENT_VERSION` (2). The Wave model: a workspace holds tabs, a tab is tiled panels.
- `Document::normalized()`: repairs a loaded document (duplicate IDs dropped, one-child splits collapsed, valid ratios, existing shown workspace, tab and focused panel; N-03: a `maximized` panel that is gone is cleared; N-10: a `main` pointing at itself, a missing workspace or another worktree is cleared); `panels()`, `panel_ids()` (every kind), N-03 `terminal_ids()` (the only panels with sessions).
- `StateFile::in_dir(dir)`, `path()`, `last_backup()`, `load() -> Loaded { document, read_only: Option<ReadOnly>, source: Source, set_aside }` (`from_fallback()`, `note()`), `save(&Document)`. Only a missing file is a fresh start (`Source::Fresh`). An unreadable file (retried 3×) is `ReadOnly::Unreadable`; a newer one `ReadOnly::Newer` (shown if it parses, never set aside); a damaged one (bad JSON or UTF-8) is copied (not renamed) to `workspaces.broken-<seconds>.json`, and `ReadOnly::NotSetAside` when that copy fails. Whenever the file can't be used the newest good backup opens (`Source::Backup`), else an empty document (`Source::Empty`). `ReadOnly`'s `Display` is the text the UI shows.
- N-03 migrations (`migrate.rs`): `parse` reads any format up to the current one, running each step on the JSON (1 → 2: a panel's terminal fields into `content`). A migrated file's bytes go first to `workspaces.v<format>-<seconds>.json` (`Loaded::migrated`), then the migrated document is saved at once; a failed copy is `ReadOnly::NotBackedUp`. `fixtures/workspaces-v1.json` is a real format 1 file for tests.
- Backups (`backup.rs`): a good file is copied to `workspaces.json.bak` at each start and to `backups/workspaces-<YYYY-MM-DD>.json` once a day (UTC); the newest 7 daily copies are kept.
- `WindowFile` / `WindowBounds` / `MonitorRef`: the window's saved place (`window.json`).

## Depends on / used by
- Depends on: `serde`, `serde_json`, `specta`, `tracing`, `wcmd-config` (`write_atomic`).
- Used by: `wcmd-app` (the state service and window restore).

## Invariants
- The UI owns the live document; the core only loads, normalizes and saves what the UI sends. Layout operations (split, close, move) are in `packages/app/src/model/`, not here.
- Every save is `write_atomic`. Never lose the user's state: a persisted-format change needs a version bump, a migration step in `migrate.rs` and a test with a real file of the older format. A new optional field with a serde default needs only the test that an older file without it loads. A content of an unknown kind is never changed or dropped.
- Never overwrite a file that could not be read or kept: every such case is a `ReadOnly` reason, and the caller saves nothing.
- These types are the contract: the UI's are generated from them.

## How to test
- `cargo test -p wcmd-state`.
