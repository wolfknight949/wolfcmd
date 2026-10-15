# Release and winget

> Status: Current · Decision: [ADR-0004](../adr/0004-open-source-and-releases.md) · Tool: `tools/release` (`pnpm release …`, details in [its notes](../../tools/release/CLAUDE.md)). For maintainers: pushing a `v*` tag, publishing a release and submitting to winget are done by hand.

WolfCmd ships as a per-user NSIS installer attached to the GitHub releases of this repository, `wolfknight949/wolfcmd` (installer, `SHA256SUMS` and notes). Users install and update with winget; the app has no updater. User data (`%APPDATA%\WolfCmd`) survives every update.

## Signed builds (GitHub Actions)
- Released installers are built by GitHub Actions from the public source ([`.github/workflows/release.yml`](../../.github/workflows/release.yml)), so code signing can prove where they came from ([code signing policy](../../CODE_SIGNING_POLICY.md)).
- **A version tag** (`git push origin vX.Y.Z`, after `pnpm release build X.Y.Z` committed the version and changelog and the commit is pushed) builds that commit, checks the tag matches the app's version, runs `pnpm check`, builds the installer, has SignPath sign it (once the `SIGNPATH_API_TOKEN` secret and the `SIGNPATH_ORGANIZATION_ID` variable are set; each request is approved in SignPath) and **drafts** the GitHub release with the installer and `SHA256SUMS` (notes from `CHANGELOG.md`). A maintainer checks the draft and publishes it, then writes and submits the winget manifests with the SHA-256 from `SHA256SUMS`.
- **Run workflow** (by hand) builds any branch and keeps the installer as an artifact, without releasing anything.
- The local steps below (`pnpm release try`, `publish`) stay for trying a build on this PC and for releasing without CI.

## Once
1. **GitHub CLI:** `gh auth login` with `repo` scope. Check: `gh repo view wolfknight949/wolfcmd`.
2. **winget tools:** `winget install Microsoft.WingetCreate`. To test manifests locally (admin PowerShell once): `winget settings --enable LocalManifestFiles`.
3. **A token for winget submissions:** a GitHub classic token with `public_repo` scope (wingetcreate forks `microsoft/winget-pkgs` under your account and opens the pull request). Keep it out of the repository; pass it with `--token` or `WINGET_CREATE_GITHUB_TOKEN`.
4. **Check `tools/release/config.json`:** `release.sourceRepo` and `release.publicRepo` (both `wolfknight949/wolfcmd`: releases go to the source repository, which must be public; a separate releases repository also works). `winget.packageIdentifier` (`Wolfknight949.WolfCmd`) is permanent after the first submission; `publisher`, `license` (`MIT`), `licenseUrl` and `shortDescription` appear on winget.
5. **Optional: code signing.** Unsigned installers work with winget, but Windows SmartScreen warns on first run. Free signing for open-source projects is available from the SignPath Foundation; once set up, put the sign command in `signing.windowsSignCommand` (`%1` = the file).

## Every release
Versions follow Semantic Versioning (features → minor, fixes → patch). All steps run on a Windows PC.
1. **Check and push:** `pnpm check`, then push `main`.
2. **Build:** `pnpm release build X.Y.Z`. It bumps the version (`tauri.conf.json`, workspace `Cargo.toml`), writes the `CHANGELOG.md` section from the commits since the last tag, commits locally (`chore(release): vX.Y.Z`, not pushed) and fills `release/vX.Y.Z/` (git-ignored): installer, `SHA256SUMS`, `notes.md`, `manifest.json`, `app/` (a runnable copy).
3. **Try:** `pnpm release try X.Y.Z` (its own test data; your workspaces untouched), then `pnpm release try X.Y.Z --install` (the real installer over your installed copy). Check: the window opens, workspaces and tabs restore, a terminal works, an agent opens from the Agents menu.
4. **Push the release commit:** `git push origin main` (publish refuses a commit the source repository doesn't have).
5. **Publish:** `pnpm release publish X.Y.Z`. It verifies the files against `manifest.json`, checks that the repository is public, creates a draft release on the built commit (`--target`) with the installer and `SHA256SUMS`, tags `vX.Y.Z` and pushes the tag, publishes the release as latest, and writes `release/vX.Y.Z/winget/`. `--draft` stops before the tag (run it again to finish).
6. **winget manifests:** `pnpm release winget X.Y.Z` (re)writes `release/vX.Y.Z/winget/` and prints the commands below.
7. **Validate and test locally:**
   - `winget validate --manifest release\vX.Y.Z\winget`
   - `winget install --manifest release\vX.Y.Z\winget` (installs from the public download URL; uninstall afterwards from Settings › Apps if needed).
8. **Submit to winget:** `wingetcreate submit --token <token> release\vX.Y.Z\winget`. It opens a pull request on `microsoft/winget-pkgs` (`manifests/w/Wolfknight949/WolfCmd/X.Y.Z/`). Bots validate it (install test, malware scan); the first submission of a new package is also reviewed by a moderator and can take a few days, later versions usually hours. Follow the PR and answer bot comments if any.
9. **Done when** the PR is merged: users get it with `winget install Wolfknight949.WolfCmd` or `winget upgrade Wolfknight949.WolfCmd` (winget's source refreshes within hours).

**Betas:** a pre-release version (`0.7.1-beta.1`) is published as its own winget package, `Wolfknight949.WolfCmd.Beta` ("WolfCmd Beta", moniker `wolfcmd-beta`), so `winget upgrade` never moves a stable install onto a beta. The tool picks it from the version; the steps are the same (the PR goes to `manifests/w/Wolfknight949/WolfCmd/Beta/X.Y.Z-beta.N/`).

## If something goes wrong
- **A bad release:** publish a fixed higher version and submit it; winget moves users forward. Never delete a published installer: winget manifests point at its URL and checksum.
- **A failed publish:** run `pnpm release publish X.Y.Z` again; it continues the draft. A draft holding files of another build must be deleted on GitHub first.
- **A rejected winget PR:** fix what the bot reports (usually the manifest: `pnpm release winget X.Y.Z` after editing `config.json`), then push to the same PR branch or close it and submit again.
