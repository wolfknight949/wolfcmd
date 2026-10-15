# release

**Purpose:** builds a WolfCmd release on a Windows PC, runs it from the dev folder, and publishes it to the GitHub releases of the public repository (with its winget manifests) when a maintainer runs `publish`. No in-app updater. The procedure: [release.md](../../docs/process/release.md).

## Public API
- Binary only: `pnpm release build X.Y.Z [--allow-dirty]`, `pnpm release try [X.Y.Z] [--copy-data | --install]`, `pnpm release publish X.Y.Z [--draft]`, `pnpm release winget X.Y.Z`.
- `config.json`: `release.sourceRepo` (`wolfknight949/wolfcmd`: the tag goes there), `release.sourceRemote` (`origin`), `release.publicRepo` (where the releases go: installers, `SHA256SUMS` and notes; today the source repository itself, which must then be public, ADR-0004; a separate releases repository also works), `winget` (`packageIdentifier` `Wolfknight949.WolfCmd`, permanent once in winget; a pre-release version is published as its own package, `<Id>.Beta` / "<Name> Beta" / `<moniker>-beta` (`WingetConfig::for_version`); `publisher`, `packageName`, `moniker`, `license`, optional `licenseUrl`, `shortDescription`, `tags`), `signing.windowsSignCommand` (`null` = unsigned).

## Depends on / used by
- Depends on: `anyhow`, `serde`, `serde_json`, `sha2`; runs `git`, `cargo`, `pnpm tauri` and `gh` as processes. No `wcmd-*` crates.
- Used by: maintainers, by hand. Never CI, never automatic.

## Invariants
- `src/plan.rs` is pure and tested: options, versions, bumps (`tauri.conf.json`, the workspace `Cargo.toml`), changelog, the manifest check, uploads (installer + `SHA256SUMS`), the release list parser (`find_release`, drafts included), `missing_assets`, `stale_assets`, `ReleaseConfig::same_repo` / `draft_target`, `app_config_problems` (no `plugins.updater` in `tauri.conf.json`; `bundle.homepage` = the public repo's page), `release_body`, and `winget_manifests` (version, installer, defaultLocale; schema `WINGET_MANIFEST_VERSION`; `nullsoft`, `Scope: user`, `/S`, no `Commands` (the installer adds nothing to the PATH), the public download URL and the installer's SHA-256 uppercase, `LicenseUrl` when configured), `winget_pkgs_folder`, `winget_instructions`. `src/main.rs` only runs processes and moves files.
- No updater: no signing key, no `.sig`, no `latest.json` (`createUpdaterArtifacts: false`).
- `build` commits locally and never pushes; `publish` uploads exactly the files `manifest.json` lists (SHA-256 checked), only from the built commit with a clean tree that the source repo already has (`gh api repos/<source>/commits/<sha>`), and only to a public repo (`gh api repos/<public> --jq .visibility`). Order: a **draft** on the public repo (`--target` the built commit when it is the source repo; none for a separate releases repo, which holds no source) with the installer and `SHA256SUMS`, notes = `notes.md`; then tag the built commit, push the tag to the source remote, publish the draft as latest, write `release/vX.Y.Z/winget/`. `--draft` stops before the tag; a repeated run continues the draft.
- `winget` only writes `release/vX.Y.Z/winget/` and prints how to check (`winget validate`) and submit (`wingetcreate submit`, or a PR to `microsoft/winget-pkgs` at `manifests/w/Wolfknight949/WolfCmd/X.Y.Z/`). Nothing in this tool submits, pushes to winget-pkgs, creates repositories or creates releases outside `publish`.
- `release/` (repository root) is git-ignored; `winget/` and `test-data/` are never in `manifest.json`; `try` always sets `WOLFCMD_DATA_DIR` to the build's `test-data` (except `--install`, which runs the installer).
- Build output is read from `CARGO_TARGET_DIR` when set, else `target/`.

## How to test
- `cargo test -p release`. A real run needs a full release build; `winget validate --manifest release/vX.Y.Z/winget` checks the manifests.
