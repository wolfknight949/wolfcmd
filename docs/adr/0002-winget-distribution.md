# ADR-0002: Distribute through winget from a public releases repository

> Status: Superseded by [ADR-0004](0004-open-source-and-releases.md) · 2026-10-15 · Related: [ADR-0001](0001-founding-architecture.md)

## Context
The source repository was private, so an in-app updater fed from its releases would need a GitHub access key in every installed copy. WolfCmd should install and update through winget, with no update notice in the app.

## Decision
- WolfCmd has **no in-app updater** and no access key: no updater plugin, no signing key for update packages, no background checks.
- Installers (per-user NSIS, silent switch `/S`) and `SHA256SUMS` are published to a separate **public** releases repository; the source stays private, and the version tag goes to the source repository.
- Users install and update with **winget**; a pre-release such as `0.7.1-beta.1` is its own package (`<Id>.Beta`), as winget-pkgs keeps betas apart. `tools/release` writes the winget manifests; submitting them to `microsoft/winget-pkgs` is a manual maintainer step.
- Publishing, tagging and submitting are done by a maintainer, by hand.

## Consequences
- Updates arrive when the user runs `winget upgrade` (or a tool that does it); the app never contacts the network by itself.
- winget points at fixed download URLs and checksums: published installers are never deleted or replaced; a fix is a new version.
- Unsigned installers trigger SmartScreen on first run until code signing is decided.
