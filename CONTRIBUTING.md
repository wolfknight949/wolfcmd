# Contributing to WolfCmd

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Before you start
- **Bugs:** open an issue with the steps, what you expected and what happened, your Windows version and WolfCmd's version (Settings › About). A screenshot helps.
- **Features:** open an issue first. WolfCmd stays small on purpose: every change is judged by how working in one or two terminals feels (fast, calm, native), and a feature is added when users ask for it. A short discussion saves you work on something that won't fit.
- **Security problems:** please don't open a public issue; see [SECURITY.md](SECURITY.md).

## Build and run
You need Windows 10 or 11, Rust at the version in [`rust-toolchain.toml`](rust-toolchain.toml) (rustup picks it up; with the MSVC build tools), Node.js 22 with pnpm (`corepack enable`), and the WebView2 runtime.

```powershell
pnpm install
pnpm dev          # the app with hot reload, on its own data folder (%APPDATA%\WolfCmd-dev)
```

`dev-local.cmd` does the same with a double-click, and can run on your real workspaces instead (it asks). `install-local.cmd` builds the current code and installs it over your installed WolfCmd.

## Find your way around
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the Rust core, the IPC and the React UI fit together.
- [docs/ROADMAP.md](docs/ROADMAP.md): the features by ID (`N-01` … `N-10`).
- [docs/adr/](docs/adr/): the decisions, and [docs/design/](docs/design/): feature designs.
- Each crate and package has a `CLAUDE.md` with its purpose, API and rules. They are short notes for contributors, people and coding agents alike; read the one of the module you change.

## Rules of the code
- **No dead code.** Everything in the repository is used; knip and clippy (`-D warnings`) check it.
- **Never lose user state.** A change to a saved format needs a version bump, a migration step and a test with a file of the older format.
- **Rust types are the contract.** The TypeScript bindings in `packages/bindings` are generated: change the Rust types, then run `pnpm gen:bindings`. Never edit them by hand.
- **Terminals never go through React state.** Output goes from the IPC channel straight into xterm.
- **Privacy.** Nothing goes to the network or to an agent without the user's action.
- UI colors, sizes and motion come from the design tokens in `packages/ui-kit` (an ESLint rule checks class lists).

## Tests
- Unit tests sit next to the code: Vitest for TypeScript, `cargo test` for Rust. Name tests after the feature they cover when there is one (`n03_drop_preview: …`).
- `pnpm check` runs the UI build, the format check, ESLint, the typecheck, knip and every unit test (TS and Rust). It must pass before a pull request.
- `pnpm e2e` builds the debug app and drives it end to end on Windows (it opens real windows and takes a few minutes). Run it when you change terminals, the layout, workspaces or saving.
- `pnpm format` formats everything (Prettier and `cargo fmt`).

## Commits and pull requests
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/) with the feature ID when there is one: `feat(app): N-03 maximize a panel with a double-click`, `fix(pty): N-02 …`, `docs: …`. `feat`, `fix` and `perf` commits go into the changelog.
- Keep a pull request to one change, describe what it does and how you tested it, and include a screenshot for anything visible.
- Significant or hard-to-reverse decisions (a new major dependency, a saved format, a protocol) get an ADR in `docs/adr/`.

## Licence
By contributing you agree that your contribution is licensed under the [MIT licence](LICENSE).
