# ADR-0003: A panel's content is tagged by its kind; unknown kinds round-trip

> Status: Accepted · 2026-10-14 · N-03 panel types ([design](../design/N-03-panel-types.md))

## Context
`workspaces.json` format 1 stored every panel as a terminal (`profile`, `cwd`, `agent` on the panel). More panel kinds are coming (the + flyout, plugins). A file must keep working when it holds a kind the running WolfCmd doesn't know: written by a newer WolfCmd, or by a plugin that isn't installed. The persisted format is hard to change later.

## Decision
- Format 2: `Panel { id, title, content }`, `content` one object with a string `kind`. The core knows `terminal`; any other kind is kept as raw JSON (`UnknownContent`) and written back unchanged. The UI never rebuilds a content it doesn't know and shows a placeholder card for it.
- Plugin kinds are named `<plugin id>.<type>`; built-in kinds have no dot.
- Older formats are migrated on load, step by step on the JSON (`wcmd-state/src/migrate.rs`). The first migration of a file keeps its bytes as `workspaces.v<format>-<seconds>.json` before the new format replaces it; if that copy fails the run is read-only.
- Files of a newer format stay read-only (unchanged rule).

## Consequences
- A type is added without a format change (a new `kind`); a new field inside a kind is a serde default or a migration step.
- Unknown fields on the panel itself (outside `content`) are not kept; a newer WolfCmd that adds them bumps the version, which older ones treat as read-only.
- Only terminal panels have sessions and scrollback; a kind with its own state keys it by panel ID, and the startup cleanup keeps files of every panel ID.
