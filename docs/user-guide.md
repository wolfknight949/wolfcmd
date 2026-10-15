# WolfCmd user guide

WolfCmd is a terminal for Windows with workspaces, made for working with AI coding agents in one or two terminals. This guide walks through what it does. For installing it, see the [README](../README.md#install).

## Workspaces

A **workspace** is a set of tabs, optionally tied to a folder (a project). New terminals and agents in a workspace start in its folder.

- The workspace's name at the top left opens the **workspace switcher**: every workspace, **New workspace** (Ctrl+Shift+N), **Open folder…** (a workspace for a folder), the shown workspace's Remote Control choice, **Settings…** and **Close workspace**.
- Each workspace has a color, shown as a small dot in the switcher.
- Right-click a workspace row (or press Shift+F10 on it) to rename it, open its folder in File Explorer or close it.
- While an agent works or has finished in a workspace you aren't looking at, its row says "Working" or "Done", and the switcher button shows a small dot.

## Tabs

A workspace's tabs are the pills in the title bar.

- **New tab:** the + after the pills, or Ctrl+Shift+T. **Duplicate:** Ctrl+Shift+D (the same layout and folders with fresh shells; agent panels start as fresh agents).
- **Switch:** click a pill, Ctrl+Tab / Ctrl+Shift+Tab, or Ctrl+Alt+1…9.
- **Reorder:** drag a pill sideways. Esc cancels the drag.
- **Rename:** double-click the pill. **Close:** its ×, a middle-click, or the pill's menu (Close, Close others, Close to the right).
- A pill shows a dot when a program in the tab wants your attention (a bell, a notification from the shell, a long command you asked to be told about), a spinner while an agent in it works, and a check once an agent finished while you were elsewhere.

## Panels

A tab is a set of **tiled panels**, each one a terminal.

- **Split:** Alt+Shift+= (right) or Alt+Shift+- (down), or the buttons on a panel's header. **Move the focus:** Alt+Arrow keys.
- **Resize:** drag the gap between two panels.
- **Move:** drag a panel's header onto another panel. Dropping near an edge splits that panel there; dropping in the middle swaps the two. The shell keeps running; Esc cancels.
- **Maximize:** the header's button, a double-click on the header, or Ctrl+Shift+Enter. The other panels keep running out of sight; the same again brings the tiles back. A maximized panel stays maximized after a restart.
- **Close:** the header's × or Ctrl+Shift+W. A panel where an agent (or a command) is still running asks first; see [Undo and closing safely](#undo-and-closing-safely).
- **Rename:** the header's menu (right-click it). A panel otherwise shows the running program's title, the agent's name or the shell's name.

### In a terminal

- **Shells:** PowerShell, Windows PowerShell, Command Prompt, Git Bash and WSL distributions are found automatically. + (top of the right bar) opens a terminal with the default shell or a chosen one; an empty tab offers one with Enter.
- **Copy and paste:** select and Ctrl+Shift+C, Ctrl+V; a right-click copies a selection or pastes. Pasting several lines into a shell asks first. Shift+right-click (or Shift+F10, or the Menu key) opens the terminal's menu: copy, paste, select all, find, clear, split and maximize.
- **Find:** Ctrl+Shift+F, with case and regex options and a match count; it can also search just one command's output.
- **Links:** Ctrl+click a web address, an OSC 8 hyperlink or a file path such as `src/main.rs:40:9` to open it. Programs are shown in File Explorer, never run.
- **Command marks:** with shell integration (set up automatically for PowerShell, Command Prompt, Git Bash, WSL bash, zsh and fish, without touching your profile), each command gets a dot in the gutter and a line on the scrollbar. Ctrl+Up / Ctrl+Down jump between commands, Shift+Ctrl+Up/Down select whole commands, a sticky header shows the command you are scrolled into, and a command's menu can copy its output or tell you when it finishes.
- **Files from Explorer:** drop them on a terminal to type their quoted paths (in the right form for the shell, WSL included).
- **Images:** paste a picture into an agent panel and the agent receives it.
- **Font size:** Ctrl+= / Ctrl+-.

## Undo and closing safely

- **Undo and redo:** Ctrl+Shift+Z undoes the last layout or workspace change and Ctrl+Shift+Y redoes it; the two arrows next to the workspace name do the same, and their tooltips say what they would undo or redo ("Undo close panel"). Ctrl+Z and Ctrl+Y stay the terminal's (Ctrl+Z suspends a program in a shell, and editors in a terminal use both).
- **What can be undone:** closing a panel, a tab or a workspace; opening a panel, a tab or a workspace (an agent, a split, a duplicated tab, a new worktree's workspace: undoing that never deletes the worktree itself); moving, swapping, maximizing and resizing panels; renaming; reordering tabs. Up to 100 steps, for as long as WolfCmd runs. Removing a git worktree can't be undone.
- **Closed terminals come back alive:** a closed panel's shell or agent keeps running for a minute, so undoing the close brings it back exactly as it was, still running. After that minute an undo still brings the panel back, as a restart would: its earlier output dimmed above a new shell, and an agent that was running resumes its session.
- If the change you undo happened in another tab or workspace, you stay where you are and a small notice says what was undone.
- **The close question:** closing a panel, a tab or a workspace where an agent is still running, or a command in a shell (one with shell integration, at work rather than at its prompt), asks first: "Close this panel? Claude Code is still running in it." Cancel has the focus, so Enter or Esc keeps everything. Quitting (Ctrl+Q, the tray's Quit) asks once while an agent runs; closing the window to the tray never asks, since nothing stops. Tick "Don't ask again" to turn the question off, and turn it back on in Settings › Window.

## Agents

The **Agents** button on the right bar lists the agent CLIs WolfCmd knows: **Claude Code**, **Codex**, **Gemini CLI**, **Copilot CLI**, **Aider** and **OpenCode**, plus any that plugins add. Installed ones come first; for the others the menu shows the install command to copy (WolfCmd never installs anything).

Choosing an agent opens a new terminal panel in the workspace's folder and starts the agent there. An agent panel is a normal terminal: you talk to the agent's own interface, and when the agent exits you are back at the shell.

### Sessions come back

After you close WolfCmd (or restart Windows), an agent panel that was running its agent starts it again and resumes **its own session** in the folder it started in:

- **Claude Code:** WolfCmd gives each panel its own session ID, so every panel resumes exactly its conversation (or starts a new one under the same ID if Claude Code never saved it).
- **Agents without session IDs** (Codex and others): the first panel of that agent in a folder continues its latest session there; further panels open the agent's session picker.
- An agent you ended (the shell back at its prompt) is not started again: the panel comes back as a plain shell.

### Working and finished

WolfCmd watches only what the terminal already shows: the agent's own title (Claude Code, Codex and Gemini CLI show a spinner there) or its output. No hooks, no changes to your projects or the agent's settings.

- While an agent works, its panel header shows a spinner in the agent's color and "Working…", and its tab pill a small spinner.
- When it finishes while you aren't looking at that panel, the header shows a check and "Done", the tab pill glows once in the agent's color and keeps a check until you look, and the agent's panel glows once in its color when it comes into view. A finish in the panel you are looking at stays quiet.
- With WolfCmd in the background, the taskbar button flashes and a notification names the agent and the tab (Settings › Agents › Notify when an agent finishes). Clicking it brings you to the panel.

### Remote Control

For agents that support it (Claude Code), WolfCmd can start them with Remote Control on, so you can follow the session from elsewhere. Set the default in Settings › Agents, or per workspace folder in the workspace switcher.

## Git worktrees

To work on separate tasks in one repository side by side, give each task its own git worktree.

- In the workspace switcher, a workspace whose folder is a git repository lists its worktrees under it, and offers **New worktree…**: a new branch (from the current HEAD) or an existing one, a location (next to the repository by default), and whether to start **empty** or with **copies of the main workspace's tabs** (agent panels start as fresh agents with new sessions).
- A worktree opens as its own workspace; the title bar shows "repo › branch". Worktrees made outside WolfCmd show up in the list too.
- **Remove worktree…** asks first, ends the worktree's terminals, then removes its folder; the branch stays. A worktree with uncommitted changes is refused unless you choose Force.

WolfCmd runs git only when you open the menu or use these commands, never in the background.

## Settings

Open **Settings** with the gear at the bottom of the right bar, Ctrl+, or the workspace switcher. Every change applies and saves at once.

- **Appearance:** theme (Dark, Light, or Auto to follow Windows), font and size, cursor style, smooth scrolling, and whether a finished agent's panel glows.
- **Terminal:** the default shell; the Kitty keyboard protocol (off by default, for programs that use it).
- **Agents:** Remote Control by default; notify when an agent finishes.
- **Window:** keep running in the tray when closed; ask before closing a running agent.
- **About:** the version and the data folder, with a button to open it.

Settings are stored in `settings.toml` in the data folder.

## Plugins

A plugin adds agent CLIs to the Agents menu. It is a folder with one file, `plugin.toml`, in `%APPDATA%\WolfCmd\plugins\<id>\`, that declares data only: WolfCmd never runs plugin code. The agent then opens like a built-in one, sessions included when the CLI supports them. Changes show the next time the Agents menu opens; a plugin with a problem is reported in one calm line at the bottom of the menu.

How to write one: [Writing a plugin agent](guides/plugins.md).

## The tray

Closing the window (its ×, Alt+F4) hides WolfCmd to the tray: terminals and agents keep running, finish notifications still arrive. Click the tray icon to bring the window back; its right-click menu has **Show WolfCmd** and **Quit WolfCmd**. **Ctrl+Q** quits from the window (both Quits ask first while an agent is running). To have the × quit instead, turn off Settings › Window › Keep running in the tray when closed. Starting WolfCmd again while it is in the tray shows the hidden window.

## Where your data lives

Everything is in `%APPDATA%\WolfCmd` (for example `C:\Users\me\AppData\Roaming\WolfCmd`); Settings › About opens it.

| File | What |
|---|---|
| `workspaces.json` | Your workspaces, tabs and panels, saved on every change |
| `workspaces.json.bak`, `backups/` | The last good copy, and one copy per day for the last 7 days |
| `window.json` | The window's position and size |
| `settings.toml` | Your settings |
| `scrollback/` | Each terminal's scrollback, shown dimmed above a "restored from …" line after a restart |
| `plugins/` | Your plugins (you create it) |

Saving is crash-safe: a file is never left half-written, even by a power cut. If `workspaces.json` is damaged, WolfCmd keeps a copy of it, opens the newest good backup and tells you; a file it can't read is never overwritten. Updates keep your data as it is.

Uninstalling (Settings › Apps) removes the program; delete `%APPDATA%\WolfCmd` too if you want your data gone.

## Privacy

WolfCmd sends nothing over the network by itself: no telemetry, no update checks. Agents start only when you open them or restore a panel that was running one, links open only when you Ctrl+click them, and git runs only when you use the workspace menu.
