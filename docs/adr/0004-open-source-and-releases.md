# ADR-0004: Open source under MIT; releases from the same public repository

> Status: Accepted · 2026-10-15 · Supersedes [ADR-0002](0002-winget-distribution.md) · Related: [ADR-0001](0001-founding-architecture.md)

## Context
WolfCmd's source was private, so its installers lived in a separate public releases repository ([ADR-0002](0002-winget-distribution.md)). The source is now public: a second repository only for installers adds a place to keep in sync and nothing else. Open source also makes free code signing for open-source projects possible.

## Decision
- **Open source under the MIT licence** (`LICENSE`), in the public repository `wolfknight949/wolfcmd`. The Rust crates and the npm packages carry `license = "MIT"` and the repository's URL.
- **Releases come from the same repository.** `tools/release/config.json` names it as both `release.sourceRepo` and `release.publicRepo`. The tool allows the two to be the same only when that repository is public (`publish` checks the visibility before it uploads anything); then the draft release is created on the built commit (`--target`), and the `vX.Y.Z` tag is pushed to it as before. Two different repositories still work (a private source with a public releases repository).
- **winget** stays the way to install and update, with no in-app updater (unchanged from ADR-0002): `Wolfknight949.WolfCmd`, and `Wolfknight949.WolfCmd.Beta` for pre-releases. The publisher is `wolfknight949` (also `bundle.publisher` in `tauri.conf.json`); the manifests carry `License: MIT`, a `LicenseUrl` and the repository as `PackageUrl`. Submitting to `microsoft/winget-pkgs` stays a manual maintainer step.
- **No CI releases.** Releases are built and published by a maintainer on a Windows PC (`pnpm release`); the repository has no GitHub Actions workflows.

## Consequences
- Installers, `SHA256SUMS` and release notes sit next to the source; the release page and the winget `PackageUrl`/`ReleaseNotesUrl` point at the same repository.
- **Code signing:** free signing through the SignPath Foundation (for open-source projects) can be applied for. Until then installers are unsigned and SmartScreen warns on first run; the release tool's `signing.windowsSignCommand` slot is where the sign command goes.
- Published installers are still never deleted or replaced: winget points at their URLs and checksums.
