# N-10: Git worktrees in a workspace

> Status: Implemented · [Roadmap](../ROADMAP.md) N-10: switch between a project's git worktrees; a new worktree starts empty or with copies of the main tree's tabs, for separate tasks in one repository

## Goal
Work on separate tasks in one repository side by side, each in its own git worktree with its own tabs, and switch between them as fast as between tabs. Calm: nothing appears for a folder that isn't a git repository.

## Model
- A worktree is a **workspace** whose `folder` is the worktree's path, linked to its repository's main workspace by a new optional field `Workspace.main: Option<String>` (the main workspace's ID). The main workspace is the one whose folder is the repository's main working tree. Everything workspaces already do (tabs, saving, restore, Remote Control by folder, agent sessions) works for worktrees unchanged.
- Format: `main` is a new optional field of document version 1 (unreleased; serde default), with a test that a file without it loads. `normalized()` clears a `main` that points at a missing workspace or at another worktree.

## Behavior
- **Workspace menu:** each main workspace lists its worktree workspaces under it, indented (name = branch; tooltip = path). Selecting one shows it. The title bar shows "repo › branch" while a worktree workspace is shown.
- **New worktree…** (in the menu of a workspace whose folder is in a git repository): a small dialog: branch name (new branch from the current HEAD, or an existing branch not checked out elsewhere), location (default `<repo-parent>\<repo>.worktrees\<branch>`, editable), and **Tabs: Empty / Copy the tabs of <main>**. Create runs `git worktree add` in the core; on success a worktree workspace opens. Copying tabs duplicates every tab's layout with new panel IDs; each panel's `cwd` inside the main tree is mapped to the same relative path in the worktree; agent panels become fresh agent panels (new session IDs; they never resume the main tree's sessions).
- **Existing worktrees:** worktrees created outside WolfCmd show in the menu (from `git worktree list --porcelain`, read when the menu opens, never polled); choosing one creates its workspace on first use.
- **Remove worktree…:** asks first; refuses (with git's reason) when the worktree has uncommitted changes, unless the user chooses Force. Closes its workspace's terminals first (Windows can't delete a folder a shell stands in), then `git worktree remove`. The branch is kept.

## Core (wcmd-app `src/git.rs`, new IPC)
- `git_worktrees({ folder }) -> { root, mainRoot, worktrees: [{ path, branch, head, isMain, locked, prunable }] } | null` (null outside a repository).
- `git_worktree_add({ folder, branch, newBranch: bool, path }) -> { path }`.
- `git_worktree_remove({ path, force }) -> ()`.
- Git runs without a window (`CREATE_NO_WINDOW`), `GIT_TERMINAL_PROMPT=0`, on a blocking thread, with a timeout; errors carry git's own message. Paths are validated (absolute, not inside another worktree).

## UI
- `model/document.ts`: `createWorktreeWorkspace(doc, mainId, path, branch, copyTabs, newId)`, `copyTabsInto` (pure, tested: IDs fresh, cwd remapped, agents fresh), `worktreesOf(doc, mainId)`.
- `chrome/WorkspaceMenu.tsx`: worktree rows and actions; `chrome/WorktreeDialog.tsx` (ui-kit dialog: focus trap, Esc, Enter).

## Tests
- Rust: real `git` in a temp repository: list, add (new and existing branch), remove clean, refuse dirty, force; a path with spaces; outside a repository → null.
- TS: copy tabs (IDs, cwd mapping, agents fresh), menu grouping, `main` repair in `normalized()` (Rust).
- E2E: create a worktree with copied tabs, switch, run `git branch --show-current` in it, remove it.

## Open questions
- None blocking. Later: show each worktree's changes count in the menu (on open only).

## As built
Decisions where this design was silent:
- `git_worktrees` also returns the local `branches`, so the dialog tells a new branch from an existing one (and one checked out elsewhere) while typing; the type is `GitRepository`.
- `git_worktree_remove` also takes the workspace's `panels`: the core ends exactly those terminals (and waits for their pseudo consoles to close), and only after its checks passed, so a refused removal leaves them running. A deletion a closing process still blocks is retried (forced, since git already checked the tree).
- A location inside the main working tree (a `.worktrees` folder there) is allowed; inside a linked worktree is refused.
- A branch with `/` becomes one folder in the default location (`feature/login` → `feature-login`). The worktree workspace is named after the branch.
- New worktree… from a worktree workspace acts on its main workspace (branch from the main tree's HEAD, the main's tabs). Copied agent panels start as fresh, running agents even when the main's had ended.
- Closing a main workspace makes its worktree workspaces plain workspaces. A worktree made outside WolfCmd opens with one empty tab.
