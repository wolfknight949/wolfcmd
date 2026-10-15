# WolfCmd (`wcmd`): notes for coding agents and contributors

A fast, calm terminal for Windows with workspaces, built to be a good home for AI coding agents. Its founding decisions: [ADR-0001](docs/adr/0001-founding-architecture.md). People start with [README.md](README.md) and [CONTRIBUTING.md](CONTRIBUTING.md); this file is the short version for anyone (or any agent) changing the code.

**Stack:** Tauri 2 + Rust core · React 19 + TypeScript UI · xterm.js · pnpm + Cargo workspaces.

## Layout
| Path | What |
|---|---|
| `crates/wcmd-app` | The Tauri app: window, IPC, terminal sessions, saving, tray, git worktrees |
| `crates/wcmd-agents`, `wcmd-state`, `wcmd-pty`, `wcmd-term`, `wcmd-config` | Agent registry and start lines; the workspace document; ConPTY shells; VT state; settings and crash-safe writes |
| `packages/app` | The React UI (`model/` → `store/` → `core/` → `terminal/` → `panels/`, `chrome/`) |
| `packages/ui-kit` | Design tokens, the icon font and UI primitives |
| `packages/bindings` | TypeScript bindings generated from the Rust IPC types (never edit by hand) |
| `resources/` | Built-in agent definitions, shell integration scripts, the bundled ConPTY |
| `tests/e2e` | End-to-end tests that drive the real app on Windows |
| `tools/` | The release tool, the icon font builder, an ESLint rule, local dev scripts |

## Read first
| Need | File |
|---|---|
| What exists and what is planned | `docs/ROADMAP.md` (feature IDs `N-xx`) |
| How the code fits together | `docs/ARCHITECTURE.md` |
| Decisions | `docs/adr/` |
| Feature designs | `docs/design/` |
| Local rules of a module | its own `CLAUDE.md` |

## Rules
- **The 1–2 terminal feel comes first.** Every change is judged by how working in one or two terminals feels: fast, calm, native. No extra panels, suggestions or process models; a feature is added when users ask for it.
- **No dead code.** Everything in the repo is used. `pnpm check` runs knip (TS) and clippy `-D warnings` (Rust).
- **Never lose user state.** The core saves the workspace document crash-safe on every change; a persisted-format change needs a version bump, a migration step and a test with a file of the older format.
- **Rust types are the contract.** TS bindings are generated (`pnpm gen:bindings`); never edit `packages/bindings`.
- **Terminals never go through React state.** Output goes from the IPC channel straight into xterm.
- **Privacy.** Nothing goes to the network or an agent without the user's action. Ctrl+click opens web addresses only.
- **Feature IDs** (`N-xx`) in key comments, test names and commits (`feat(app): N-03 …`).
- Significant or hard-to-reverse decisions get an ADR in `docs/adr/`.
- Versions follow Semantic Versioning (features → minor, fixes → patch); distribution is through winget ([release.md](docs/process/release.md)). Releases are published by maintainers, by hand.
- Run `pnpm check` before every pull request.

## Commands
| Command | Does |
|---|---|
| `pnpm install` | Installs the JS dependencies (Rust ones come with the first build) |
| `pnpm dev` | Runs the app with hot reload (Vite on :1420 + `tauri dev`); data in `%APPDATA%\WolfCmd-dev` |
| `pnpm build` | Release build + NSIS installer |
| `pnpm gen:bindings` | Regenerates `packages/bindings` from `crates/wcmd-app` |
| `pnpm check` | Build UI, format check, lint, typecheck, knip, tests (TS + Rust) |
| `pnpm e2e` | Builds the debug app and drives it end to end (`tests/e2e`, Windows, real windows; not in `pnpm check`) |
| `pnpm format` | Prettier + `cargo fmt` |
| `dev-local.cmd` | Double-click: hot reload on test data or on your own workspaces and settings (it asks; refuses while the installed app runs). Steps: `tools/local/dev.ps1` (`-Mine` / `-Test`) |
| `install-local.cmd` | Double-click: builds the current code and installs it as your WolfCmd (`tools/local/install.ps1`). Never versions or publishes |
| `pnpm release build/try/publish/winget X.Y.Z` | Maintainers: local release build, try it, publish, winget manifests ([release.md](docs/process/release.md)) |
