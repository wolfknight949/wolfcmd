# N-11: Undo and redo, and a question before closing what runs

> Status: Implemented · [Roadmap](../ROADMAP.md) N-11: closing a running agent asks first; layout and workspace actions can be undone and redone, and a closed terminal comes back alive

## Goal
Two safety nets for the one-or-two-terminal flow, designed together because they meet at the same moment: closing something by mistake.
- A close never ends a running agent (or a running command) silently: it asks once, calmly.
- A close, a split, a move or a rename can be taken back, and a closed terminal comes back **alive**: the same shell or agent, its screen exactly as it was.

## Which closes ask (`model/close-rules.ts`)
- Closing a **panel**, a **tab** (also Close others, Close to the right) or a **workspace** asks only when something in it runs:
  - an **agent** whose `AgentRef.running` is true (or that is working right now, the N-06 activity);
  - a **command in a plain shell**, from shell integration's marks (OSC 133: `C` started a command, `A`/`B`/`D` the prompt is back; `store/commands.ts`). A shell at its prompt is idle; a shell that marks no command starts (cmd) or has no integration never asks. Most terminals ask for a running command too, so this one does.
- **Quitting** (Ctrl+Q, the tray's Quit) asks only for running agents ("…still running; it resumes at the next start."), once for all of them.
- **Closing the window to the tray never asks**: nothing ends.
- The question is ui-kit `Dialog` (`chrome/CloseDialog.tsx`): "Close this panel? Claude Code is still running in it.", for tabs and workspaces how many agents ("3 agents (Claude Code and Codex) are still running in it."). Close (danger) and Cancel; Cancel has the focus, so Enter keeps everything and Esc cancels. "Don't ask again" turns the setting `window.confirm_close` off (on by default; Settings › Window turns it back on).
- **One place:** every close path is an action (`actions.ts`: `closePanel`, `closeTab`, `closeOtherTabs`, `closeTabsToRight`, `closeWorkspace`, `quit`) and goes through `guarded`: the ✕ buttons, a middle-click on a pill, Ctrl+Shift+W, the context menus, the workspace menu and the unknown-kind card's Close.
- **The tray's Quit** is the core's (`tray.rs`): with the setting on and an agent running in a panel of the document (`LocalSessionHost::running_agents`, the agent's line typed and its prompt not back) it shows the window and sends `quit-requested`; the page asks as for Ctrl+Q. Otherwise it quits at once. A second tray Quit within 10 s quits at once, so a page that can't answer never keeps WolfCmd from quitting.

## Undo and redo (`model/history.ts`, `store/workspaces.ts`)
- **Undoable steps:** closing a panel, a tab (or several) or a workspace; opening a panel (a terminal, an agent, a split), a tab (new, duplicate) or a workspace (new, open folder, new worktree, open worktree); moving and swapping panels; maximize and restore; resizing (one step per divider drag; quick drags of one divider are one step); renaming a panel, tab or workspace; reordering tabs. Undoing a new worktree closes its workspace only: the git worktree stays (the menu lists it).
- **Not steps:** where the user looks (the shown workspace and tab, the focus) and what the terminals report (a folder, an agent that ended). Removing a git worktree is not undoable and clears the history (nothing before it can come back without its folder).
- **History:** in the UI store, memory only, at most 100 steps. Each step keeps the document before and after it (documents are immutable, so this costs little). A change that changes nothing returns the same document and is no step. Steps that name the same group (`resize:<split>`, `rename:<id>`) within one second are one step.
- **Undo brings the document before back, redo the one after,** with two rules:
  - panels in both documents keep their present content (the folder a shell moved to, an agent that ended), so undo never resurrects stale terminal state;
  - if the user is still where the step was made (the same workspace and tab), the step's own tab and focus come back with it (undoing a closed tab shows it again); otherwise the user stays where they are and, when nothing on screen changed, a small notice says what happened ("Panel restored", "Tab restored", "Workspace restored", "Undone: split right"; `chrome/undo-notice.ts`, floating under the title bar for a moment).
- **The UI:** Undo and Redo as two quiet line icons right after the workspace switcher (`chrome/UndoButtons.tsx`): the calmest stable place, grouped with the document's navigation and never moving with the tab strip. Disabled when there is nothing to undo or redo; the tooltips name the step ("Undo close panel (Ctrl+Shift+Z)").
- **Keys:** Ctrl+Shift+Z undoes, Ctrl+Shift+Y redoes (Cmd+Shift on macOS). Never Ctrl+Z / Ctrl+Y: they belong to the terminal (Ctrl+Z suspends a job in a shell, editors in a terminal undo with them). Neither chord is taken by WolfCmd, the shells' line editors or the agents; in a terminal without the Kitty keyboard protocol it would send the same byte as Ctrl+Z anyway, so taking it costs the terminal nothing.

## Terminals come back alive (the core: `session/undo_grace.rs`)
Before N-11, a terminal panel's session ended as soon as the panel left the saved document. Now:
- `state_save` takes `undoable`: the panels not in the document that the UI's history can still bring back (`undoablePanels`). A terminal panel that leaves the document and is in that list **waits** (`UndoGrace`): its shell or agent keeps running, its scrollback keeps being saved, the orphan sweep leaves it alone.
- It ends at the first of:
  - **60 s** after it closed (`UNDO_GRACE`; the keeper's sweep): its scrollback is saved first, so a later undo shows it above a new shell as a restart would;
  - the history **dropping** it: a later save without it in `undoable` (a new step cleared the redo, the depth was reached, a reloaded page has no history and sends none);
  - the removal of its **git worktree** (the UI passes the waiting panels with the worktree's own: they may stand in its folder);
  - **quit** (`kill_all`).
  Nothing can leak: every waiting session has a deadline, and quit ends them all.
- **Undo within the grace** puts the panel back in the document: it is a panel again, the view's `pty_open` attaches to the same session (the screen replayed exactly, as after a reload), and an agent is still the same running agent.
- **Undo after the grace** brings the panel back as a restart would: its saved scrollback dim above a divider, a new shell in its folder, and an agent that still ran resumes its own session (`restoreStart`, the N-06 resume logic).
- **Decision record:** ADR-0001 is unchanged: the core still owns the sessions and a page still never ends a terminal (a reloaded page's first save lets the waiting sessions go because they can no longer be undone, which is what closing them already meant). Only the moment a closed panel's session ends moved, so this note records it; no new ADR.

## Tests
- Rust: `session/undo_grace.rs` (waits only while undoable, the grace runs out, a panel brought back stops waiting, a dropped panel ends, closing again starts a fresh grace); `session/local.rs` (a real cmd: survives the orphan sweep within the grace, an undo reattaches the same shell with its screen, after the grace it ends and a reopened panel restores its scrollback); `ipc/state.rs` (`state_save`'s `undoable` through a save, an undo and the history dropping it); `tray.rs` (when the tray's Quit asks); the setting's default and round trip.
- TS: `model/history.test.ts` (undo, redo, no redo after a new step, the depth, grouping, terminal state kept, where the user is, a closed tab shown again, the undoable panels), `model/close-rules.test.ts`, `store/workspaces.test.ts`, `actions.test.ts` (which closes ask, Cancel, Close and undo, Don't ask again, the quit), `chrome/CloseDialog.test.tsx` (focus, Esc, the answer), `keys.test.ts`.
- e2e (`tests/e2e/src/undo.e2e.ts`): an idle shell closes without asking and comes back; closing a stand-in agent asks, Enter (Cancel) keeps it, Close then Ctrl+Shift+Z brings it back with its text and still running, Ctrl+Shift+Y closes it again; a closed tab comes back, goes again, comes back; an undo in another tab shows the notice.
