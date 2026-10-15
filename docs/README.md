# WolfCmd documentation

## Using WolfCmd
- [User guide](user-guide.md): workspaces, tabs, panels, agents and their sessions, git worktrees, settings, plugins, the tray, where your data lives.
- [Writing a plugin agent](guides/plugins.md): add your own agent CLI to the Agents menu.

## Working on WolfCmd
- [Contributing](../CONTRIBUTING.md): build, test, commit style.
- [Architecture](ARCHITECTURE.md): how the Rust core, the IPC and the React UI fit together.
- [Roadmap](ROADMAP.md): the features by ID (`N-xx`) and their status.
- [Adding a panel type](guides/panel-types.md).
- Architecture decision records:
  - [ADR-0001](adr/0001-founding-architecture.md): a lean terminal with workspaces, built around the core's sessions
  - [ADR-0002](adr/0002-winget-distribution.md): winget from a public releases repository (superseded by ADR-0004)
  - [ADR-0003](adr/0003-panel-content-by-kind.md): a panel's content is tagged by its kind
  - [ADR-0004](adr/0004-open-source-and-releases.md): open source under MIT; releases from the same public repository
- Feature designs: [context menus and maximize](design/N-03-context-menus-and-maximize.md), [panel types](design/N-03-panel-types.md), [agent activity](design/N-06-agent-activity.md), [settings](design/N-07-settings.md), [plugins](design/N-09-plugins.md), [git worktrees](design/N-10-worktrees.md), [undo and the close question](design/N-11-undo-and-close-confirmation.md).
- [Release and winget](process/release.md): how maintainers publish a version.
- Each crate and package has a `CLAUDE.md`: its purpose, API and rules, for contributors and coding agents.
