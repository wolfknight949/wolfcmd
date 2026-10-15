# N-03: Panel types (document format 2)

> Status: Implemented · [Roadmap](../ROADMAP.md) N-03: the + flyout adds a terminal panel without an agent, the first of more panel types to come, so panel types must be extensible. Format decision: [ADR-0003](../adr/0003-panel-content-by-kind.md).

## Goal
A panel is not always a terminal. The + flyout and its add-entry registry exist; underneath, panel types were hard-coded (every panel had a shell's `profile`, `cwd` and `agent`). Make the type a registry entry, in the saved file and in the UI, without losing anything a user saved.

## Saved format (`wcmd-state`, version 2)
- `Panel { id, title, content: PanelContent }`. `content` is one object whose `kind` names the type.
- `PanelContent::Terminal(TerminalContent { kind: "terminal", profile, cwd, agent })`: the one built-in kind. Only terminal panels have sessions.
- `PanelContent::Unknown(UnknownContent { kind, ..fields })`: any other kind (a newer WolfCmd's, a plugin's that isn't installed) is kept whole and written back untouched. The deserializer reads `kind` first: `terminal` must be a valid terminal (a damaged one is a damaged file, as in format 1), anything else round-trips; a content without `kind` is damaged.
- Plugin kinds are `<plugin id>.<type>` (plugin IDs have no dot); built-in kinds have none. The placeholder uses this to say what is missing.

## Migration (`migrate.rs`)
- Load reads the JSON, checks `version`, runs each step up to `CURRENT_VERSION` on the JSON value, then builds the `Document`. 1 → 2 moves each panel's `profile`, `cwd` and `agent` into `content: { kind: "terminal", … }`; titles, splits, ratios, `focused`, `maximized`, `main` and every other field stay.
- The first time a file is migrated its bytes are copied to `workspaces.v1-<seconds>.json` (beside it, like `workspaces.broken-*`), then the migrated document is written at once, so the next start reads format 2 and makes no second copy. If the copy fails the run is read-only (`ReadOnly::NotBackedUp`): the old file stays the only copy.
- Backups (`.bak`, daily) of format 1 open through the same migration.
- A format 2 file is never written by a format 1 WolfCmd: that version already treats a newer `version` as read-only.

## Core
- `Document::panels()`, `panel_ids()` (every kind), `terminal_ids()`. `state_save` ends the sessions of terminal panels that left; the session host's orphan sweep keeps only sessions whose panel is a terminal (`StateService::has_terminal`). Scrollback cleanup at start keeps files of every panel ID, of any kind.

## UI
- `model/panels.ts`: `terminalOf`, `agentOf`, `panelFolder`, `terminalPanel`, `changeTerminal`, `withCwd`, `missingType`. Model code never rebuilds a content it doesn't know: an unknown kind's content is the same object after every operation (split, move, swap, maximize, rename, close others, duplicate tab, copy into a worktree).
- `panels/types.ts`: `PanelType { id, order, kind, label, View, Header, add? }` in a registry made by `createRegistry` (`chrome/registry.ts`). `panels/builtin-types.ts` registers `TERMINAL_TYPE` (`panels/TerminalType.tsx`: `TerminalPanel`, its header look, `TERMINAL_ENTRY`).
- `TabView` draws each card through the type registered for its content's kind (`typeFor`), never a switch; the view is memoized (`PanelBody`), so the render counts stay as they were. Views get one set of shared callbacks: `onChange(panelId, change)`, `onFocus`, `onLayout`.
- `PanelHeader` is shared: a type's `Header` gives it a `HeaderLook` (title, icon, color, folder).
- A kind nobody registered gets `UNKNOWN_TYPE` (`panels/UnknownPanel.tsx`): "This panel needs a newer WolfCmd." or "This panel needs the plugin “X”.", and Close.
- `actions.addPanel(content, side?)` places a panel of any type; the add entry of a type calls it.

## Tests
- Rust: a real format 1 file (`crates/wcmd-state/fixtures/workspaces-v1.json`) migrates with every panel, agent, session, ratio, `maximized` and `main`; saves as v2 and reads back equal; an unknown kind round-trips; bad terminals and kind-less contents are damaged; the v1 copy is made once; a failed copy is read-only and touches nothing; only terminals have sessions (`wcmd-app`).
- UI: `model/unknown-kind.test.ts` (every layout operation), `TabView.test.tsx` (the placeholder card, Close, the content kept).
- End to end: `app.e2e.ts` "N-03 a format 1 workspaces.json opens…": shells in their folders, the copy, format 2 on disk, no second copy on the next start.
