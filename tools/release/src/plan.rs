//! The release tool's pure parts (tested): options, versions, file
//! bumps, the changelog, the names and URLs of what is uploaded, the release list parser, and
//! the winget manifests.

use std::cmp::Ordering;
use std::fmt;
use std::fmt::Write as _;

use anyhow::{Context as _, bail};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

/// `tools/release/config.json`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Config {
    pub(crate) release: ReleaseConfig,
    pub(crate) winget: WingetConfig,
    #[serde(default)]
    pub(crate) signing: SigningConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReleaseConfig {
    /// `owner/name` of the source repository: the release tag `vX.Y.Z` is pushed there, and
    /// `publish` refuses a built commit it doesn't have yet.
    pub(crate) source_repo: String,
    /// The source repository's remote in this checkout (where the tag is pushed).
    #[serde(default = "default_remote")]
    pub(crate) source_remote: String,
    /// `owner/name` of the **public** repository the releases go to (installers, their sums
    /// and the release notes); winget downloads from it. The source repository itself when
    /// that is public (ADR-0004), or a releases repository of its own.
    pub(crate) public_repo: String,
}

impl ReleaseConfig {
    /// Whether the releases go to the source repository itself (it must then be public).
    pub(crate) fn same_repo(&self) -> bool {
        self.source_repo.eq_ignore_ascii_case(&self.public_repo)
    }

    /// The commit a new draft release is created on (`gh release create --target`): the built
    /// commit when the releases go to the source repository; none for a releases repository of
    /// its own, which holds no source (GitHub tags its default branch there).
    pub(crate) fn draft_target<'a>(&self, commit: &'a str) -> Option<&'a str> {
        self.same_repo().then_some(commit)
    }
}

fn default_remote() -> String {
    "origin".to_owned()
}

/// What the winget manifests say about the package (the per-version parts come from the
/// build).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WingetConfig {
    /// `Publisher.Name` (`Wolfknight949.WolfCmd`): permanent once the first version is in
    /// winget, since installs upgrade by it.
    pub(crate) package_identifier: String,
    pub(crate) publisher: String,
    pub(crate) package_name: String,
    #[serde(default)]
    pub(crate) moniker: Option<String>,
    /// The license's name as winget shows it (`MIT`).
    pub(crate) license: String,
    /// Where the license's text is (the locale manifest's `LicenseUrl`), if anywhere.
    #[serde(default)]
    pub(crate) license_url: Option<String>,
    pub(crate) short_description: String,
    #[serde(default)]
    pub(crate) tags: Vec<String>,
}

impl WingetConfig {
    /// What winget calls the package for `version`: a pre-release (`0.7.1-beta.1`) is its own
    /// package (`<Id>.Beta`, "<Name> Beta", `<moniker>-beta`), as winget-pkgs keeps betas apart, so
    /// `winget upgrade` never moves a stable install onto a beta.
    pub(crate) fn for_version(&self, version: &Version) -> Self {
        if version.pre.is_none() {
            return self.clone();
        }
        Self {
            package_identifier: format!("{}.Beta", self.package_identifier),
            package_name: format!("{} Beta", self.package_name),
            moniker: self.moniker.as_ref().map(|m| format!("{m}-beta")),
            ..self.clone()
        }
    }
}

/// Code signing: releases are unsigned until a signing service is set up (free signing for
/// open-source projects from the `SignPath` Foundation is the candidate, ADR-0004). A command
/// here (Tauri's `bundle.windows.signCommand`, `%1` = the file) signs the app and the
/// installer, e.g. `trusted-signing-cli -e … -a … -c … %1` or `signtool sign …`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SigningConfig {
    pub(crate) windows_sign_command: Option<String>,
}

pub(crate) fn parse_config(text: &str) -> anyhow::Result<Config> {
    let config: Config = serde_json::from_str(text).context("tools/release/config.json")?;
    for (key, repo) in [
        ("release.sourceRepo", &config.release.source_repo),
        ("release.publicRepo", &config.release.public_repo),
    ] {
        let parts: Vec<&str> = repo.split('/').collect();
        if parts.len() != 2 || parts.iter().any(|p| p.trim().is_empty()) {
            bail!("{key} must be owner/name, got {repo:?}");
        }
    }
    if !valid_package_identifier(&config.winget.package_identifier) {
        bail!(
            "winget.packageIdentifier must be like Publisher.Name, got {:?}",
            config.winget.package_identifier
        );
    }
    let w = &config.winget;
    for (key, value) in [
        ("winget.publisher", &w.publisher),
        ("winget.packageName", &w.package_name),
        ("winget.license", &w.license),
        ("winget.shortDescription", &w.short_description),
    ] {
        if value.trim().is_empty() {
            bail!("{key} must not be empty");
        }
    }
    if let Some(tag) = w
        .tags
        .iter()
        .find(|t| t.is_empty() || t.len() > 40 || t.chars().any(char::is_whitespace))
    {
        bail!("winget.tags: {tag:?} must be one word of at most 40 characters");
    }
    Ok(config)
}

/// winget's `PackageIdentifier` rule: 2 to 8 dot-separated parts of 1 to 32 characters,
/// without whitespace or `\ / : * ? " < > |`.
pub(crate) fn valid_package_identifier(id: &str) -> bool {
    let parts: Vec<&str> = id.split('.').collect();
    (2..=8).contains(&parts.len())
        && parts.iter().all(|part| {
            (1..=32).contains(&part.chars().count())
                && !part.chars().any(|c| {
                    c.is_whitespace()
                        || c.is_control()
                        || matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
                })
        })
}

/// The steps of a release: build locally, try it from the dev folder, publish by hand, then
/// the winget manifests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Command {
    /// Bump, changelog, commit and build into `release/vX.Y.Z/` with a manifest. No upload.
    Build {
        version: Version,
        /// Build with uncommitted changes (the manifest says so; `publish` then refuses).
        allow_dirty: bool,
    },
    /// Run a built version from the dev folder with its own test data folder.
    Try {
        /// The newest build when absent.
        version: Option<Version>,
        /// Run the installer instead (an installed-app test; it uses the real data folder).
        install: bool,
        /// Start the test data folder from a copy of the real one (upgrade and backup path).
        copy_data: bool,
    },
    /// Publish exactly what `build` made (a maintainer's step, never automatic).
    Publish {
        version: Version,
        /// Keep the GitHub release a draft (running `publish` again finishes it).
        draft: bool,
    },
    /// (Re)write the winget manifests and say how to submit them. Submits nothing.
    Winget { version: Version },
}

pub(crate) const USAGE: &str = "\
Usage:
  pnpm release build X.Y.Z [--allow-dirty]
      Set the version everywhere, write the changelog section, commit both (locally), then
      build the installer into release/vX.Y.Z/ with manifest.json (SHA-256 of
      every file) and SHA256SUMS. Nothing is uploaded.
  pnpm release try [X.Y.Z] [--copy-data | --install]
      Run that build's WolfCmd.exe from release/vX.Y.Z/app with its own data folder
      (release/vX.Y.Z/test-data): your real workspaces are never touched.
      --copy-data  start from a copy of your real data folder (tests the upgrade and backups)
      --install    run the installer instead (an installed-app test, with your real data)
  pnpm release publish X.Y.Z [--draft]
      A maintainer's step, never automatic. Checks every file against manifest.json, that
      the source is still the commit it was built from and that this commit is pushed.
      Creates a draft release on the public repository (release.publicRepo) with the
      installer, SHA256SUMS and the notes, tags the built commit vX.Y.Z and pushes the tag to
      the source repository, publishes the release, and writes the winget manifests into
      release/vX.Y.Z/winget/.
      --draft     stop before the tag and the publishing; running `publish` again finishes it
  pnpm release winget X.Y.Z
      Write the winget manifests into release/vX.Y.Z/winget/ again and print how to submit
      them to microsoft/winget-pkgs. Never submits or pushes anything.";

pub(crate) fn parse_command(args: &[String]) -> anyhow::Result<Command> {
    // `pnpm release -- build …` passes the separator through.
    let args: Vec<&str> = args
        .iter()
        .map(String::as_str)
        .filter(|a| *a != "--")
        .collect();
    let Some((step, rest)) = args.split_first() else {
        bail!("{USAGE}");
    };
    let mut version = None;
    let mut flags = Vec::new();
    for arg in rest {
        if let Some(flag) = arg.strip_prefix("--") {
            if let Some(value) = flag.strip_prefix("version=") {
                version = Some(Version::parse(value)?);
            } else if flag != "version" {
                flags.push(flag);
            }
        } else if version.is_none() {
            version = Some(Version::parse(arg)?);
        } else {
            bail!("unexpected {arg:?}\n\n{USAGE}");
        }
    }
    let allowed: &[&str] = match *step {
        "build" => &["allow-dirty"],
        "try" => &["install", "copy-data"],
        "publish" => &["draft"],
        "winget" => &[],
        other => bail!("unknown step {other:?}\n\n{USAGE}"),
    };
    if let Some(flag) = flags.iter().find(|f| !allowed.contains(f)) {
        bail!("--{flag} doesn't go with `{step}`\n\n{USAGE}");
    }
    let has = |name: &str| flags.contains(&name);
    let needs = |version: Option<Version>| {
        version.with_context(|| format!("`{step}` needs a version (X.Y.Z)\n\n{USAGE}"))
    };
    Ok(match *step {
        "build" => Command::Build {
            version: needs(version)?,
            allow_dirty: has("allow-dirty"),
        },
        "try" => {
            if has("install") && has("copy-data") {
                bail!("--install uses the real data folder; --copy-data is for the dev-folder run");
            }
            Command::Try {
                version,
                install: has("install"),
                copy_data: has("copy-data"),
            }
        }
        "winget" => Command::Winget {
            version: needs(version)?,
        },
        _ => Command::Publish {
            version: needs(version)?,
            draft: has("draft"),
        },
    })
}

/// `release/vX.Y.Z/manifest.json`: what `build` made, so `publish` uploads exactly that.
/// (An extra `signed` field, an updater signature, is ignored.)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Manifest {
    pub(crate) version: String,
    /// The source commit it was built from.
    pub(crate) commit: String,
    /// Built with uncommitted changes (`--allow-dirty`): never publishable.
    pub(crate) dirty: bool,
    /// UTC build time.
    pub(crate) built: String,
    /// Every file under the version's folder (paths with `/`), except the test data and the
    /// winget manifests.
    pub(crate) files: Vec<FileEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileEntry {
    pub(crate) path: String,
    pub(crate) sha256: String,
    pub(crate) size: u64,
}

impl Manifest {
    /// The SHA-256 of a built file (lowercase hex), if the build has it.
    pub(crate) fn sha256_of(&self, path: &str) -> Option<&str> {
        self.files
            .iter()
            .find(|e| e.path == path)
            .map(|e| e.sha256.as_str())
    }
}

/// What differs between the manifest and the files found now (path → SHA-256).
pub(crate) fn verify(manifest: &Manifest, found: &[(String, String)]) -> Vec<String> {
    let mut problems = Vec::new();
    for entry in &manifest.files {
        match found.iter().find(|(path, _)| *path == entry.path) {
            None => problems.push(format!("{} is missing", entry.path)),
            Some((_, sha)) if *sha != entry.sha256 => {
                problems.push(format!("{} changed since the build", entry.path));
            }
            Some(_) => {}
        }
    }
    for (path, _) in found {
        if !manifest.files.iter().any(|e| e.path == *path) {
            problems.push(format!("{path} was not part of the build"));
        }
    }
    problems
}

pub(crate) const SUMS_FILE: &str = "SHA256SUMS";

/// The files `publish` attaches to the public release, in order: the installer, then its sums.
pub(crate) fn uploads(version: &Version) -> Vec<String> {
    vec![installer_name(version), SUMS_FILE.to_owned()]
}

/// `SHA256SUMS` for the uploaded files (from the manifest).
pub(crate) fn sums(manifest: &Manifest, names: &[String]) -> String {
    let mut out = String::new();
    for name in names {
        if let Some(sha) = manifest.sha256_of(name) {
            let _ = writeln!(out, "{sha}  {name}");
        }
    }
    out
}

/// The newest version among `release/` folder names (`v0.2.0`).
pub(crate) fn newest(names: &[String]) -> Option<Version> {
    names
        .iter()
        .filter_map(|n| n.strip_prefix('v'))
        .filter_map(|v| Version::parse(v).ok())
        .max()
}

/// `SemVer` `MAJOR.MINOR.PATCH` with an optional `-pre` (`0.3.0-beta.1`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Version {
    pub(crate) major: u64,
    pub(crate) minor: u64,
    pub(crate) patch: u64,
    pub(crate) pre: Option<String>,
}

impl Version {
    pub(crate) fn parse(text: &str) -> anyhow::Result<Self> {
        let text = text.trim().trim_start_matches('v');
        let (core, pre) = match text.split_once('-') {
            Some((core, pre)) => (core, Some(pre.to_owned())),
            None => (text, None),
        };
        let numbers: Vec<&str> = core.split('.').collect();
        let number = |s: &str| -> anyhow::Result<u64> {
            if s.is_empty() || (s.len() > 1 && s.starts_with('0')) {
                bail!("{text:?} is not a version (X.Y.Z)");
            }
            s.parse()
                .with_context(|| format!("{text:?} is not a version (X.Y.Z)"))
        };
        if numbers.len() != 3 {
            bail!("{text:?} is not a version (X.Y.Z)");
        }
        if pre.as_deref().is_some_and(|p| {
            p.is_empty()
                || !p
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'))
        }) {
            bail!("{text:?} has an invalid pre-release part");
        }
        Ok(Self {
            major: number(numbers[0])?,
            minor: number(numbers[1])?,
            patch: number(numbers[2])?,
            pre,
        })
    }

    pub(crate) fn tag(&self) -> String {
        format!("v{self}")
    }
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)?;
        if let Some(pre) = &self.pre {
            write!(f, "-{pre}")?;
        }
        Ok(())
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.major, self.minor, self.patch)
            .cmp(&(other.major, other.minor, other.patch))
            .then_with(|| match (&self.pre, &other.pre) {
                (None, None) => Ordering::Equal,
                // A pre-release comes before its release.
                (None, Some(_)) => Ordering::Greater,
                (Some(_), None) => Ordering::Less,
                (Some(a), Some(b)) => a.cmp(b),
            })
    }
}

/// `tauri.conf.json`: the first `"version": "old"` becomes `new` (formatting kept).
pub(crate) fn bump_json_version(text: &str, old: &str, new: &str) -> anyhow::Result<String> {
    let from = format!("\"version\": \"{old}\"");
    if !text.contains(&from) {
        bail!("no {from} found");
    }
    Ok(text.replacen(&from, &format!("\"version\": \"{new}\""), 1))
}

/// A `Cargo.toml`: the `[package]` or `[workspace.package]` table's `version = "old"` becomes
/// `new`. `None` when the package has another version (tools are `0.0.0`) or none.
pub(crate) fn bump_cargo_version(text: &str, old: &str, new: &str) -> Option<String> {
    let mut in_package = false;
    let mut done = false;
    let mut out = String::with_capacity(text.len());
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_package = trimmed == "[package]" || trimmed == "[workspace.package]";
        }
        if in_package && !done && trimmed == format!("version = \"{old}\"") {
            out.push_str(&line.replacen(old, new, 1));
            done = true;
        } else {
            out.push_str(line);
        }
    }
    done.then_some(out)
}

/// The app's version in `tauri.conf.json`.
pub(crate) fn app_version(tauri_conf: &str) -> anyhow::Result<Version> {
    let value: serde_json::Value = serde_json::from_str(tauri_conf).context("tauri.conf.json")?;
    let version = value
        .get("version")
        .and_then(serde_json::Value::as_str)
        .context("tauri.conf.json has no version")?;
    Version::parse(version)
}

/// What in `tauri.conf.json` doesn't fit the distribution: an updater plugin (the
/// app has none), or a homepage (the installed app's support link) that isn't the page of
/// the repository the releases go to.
pub(crate) fn app_config_problems(tauri_conf: &str, config: &Config) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(tauri_conf) else {
        return vec!["tauri.conf.json is not JSON".to_owned()];
    };
    let mut problems = Vec::new();
    if value.pointer("/plugins/updater").is_some() {
        problems.push(
            "tauri.conf.json → plugins.updater: WolfCmd has no in-app updater; \
             remove it"
                .to_owned(),
        );
    }
    let homepage = repo_page(&config.release.public_repo);
    let found = value
        .pointer("/bundle/homepage")
        .and_then(serde_json::Value::as_str);
    if found != Some(homepage.as_str()) {
        problems.push(format!(
            "tauri.conf.json → bundle.homepage must be {homepage} (release.publicRepo), found \
             {found:?}"
        ));
    }
    problems
}

/// `https://github.com/<repo>`.
pub(crate) fn repo_page(repo: &str) -> String {
    format!("https://github.com/{repo}")
}

/// An uploaded file of a public release by its download address: what winget downloads.
pub(crate) fn download_url(repo: &str, version: &Version, file: &str) -> String {
    format!(
        "https://github.com/{repo}/releases/download/{}/{file}",
        version.tag()
    )
}

/// A release's page (the winget manifest's release notes link).
pub(crate) fn release_page(repo: &str, version: &Version) -> String {
    format!("https://github.com/{repo}/releases/tag/{}", version.tag())
}

/// A file attached to a GitHub release.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Asset {
    pub(crate) name: String,
    /// Bytes, `0` when GitHub didn't say.
    pub(crate) size: u64,
}

/// A release as `gh api repos/<repo>/releases` lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ReleaseInfo {
    pub(crate) draft: bool,
    pub(crate) assets: Vec<Asset>,
}

/// The release tagged `tag` in the JSON list `gh api repos/<repo>/releases` prints (drafts
/// included: the by-tag endpoint doesn't return them).
pub(crate) fn find_release(list_json: &str, tag: &str) -> anyhow::Result<Option<ReleaseInfo>> {
    let list: serde_json::Value =
        serde_json::from_str(list_json).context("the GitHub release list")?;
    let releases = list
        .as_array()
        .context("the GitHub release list is not a list")?;
    let Some(release) = releases
        .iter()
        .find(|r| r.get("tag_name").and_then(serde_json::Value::as_str) == Some(tag))
    else {
        return Ok(None);
    };
    let assets = release
        .get("assets")
        .and_then(serde_json::Value::as_array)
        .map(|assets| {
            assets
                .iter()
                .filter_map(|asset| {
                    Some(Asset {
                        name: asset.get("name")?.as_str()?.to_owned(),
                        size: asset
                            .get("size")
                            .and_then(serde_json::Value::as_u64)
                            .unwrap_or(0),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(Some(ReleaseInfo {
        draft: release
            .get("draft")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        assets,
    }))
}

/// The names in `wanted` that are not attached to the release yet.
pub(crate) fn missing_assets(wanted: &[String], present: &[Asset]) -> Vec<String> {
    wanted
        .iter()
        .filter(|name| !present.iter().any(|a| a.name == **name))
        .cloned()
        .collect()
}

/// The attached files whose size differs from the build's (a draft left by another build of
/// the same version).
pub(crate) fn stale_assets(manifest: &Manifest, present: &[Asset]) -> Vec<String> {
    present
        .iter()
        .filter(|asset| asset.size != 0)
        .filter(|asset| {
            manifest
                .files
                .iter()
                .any(|entry| entry.path == asset.name && entry.size != asset.size)
        })
        .map(|asset| asset.name.clone())
        .collect()
}

/// Tauri's NSIS installer name.
pub(crate) fn installer_name(version: &Version) -> String {
    format!("WolfCmd_{version}_x64-setup.exe")
}

/// The `--config` Tauri merges for a release build: no updater artifacts, and the Authenticode
/// signing command when one is configured.
pub(crate) fn release_tauri_config(signing: &SigningConfig) -> serde_json::Value {
    let mut bundle = serde_json::json!({ "createUpdaterArtifacts": false });
    if let Some(command) = signing
        .windows_sign_command
        .as_deref()
        .filter(|c| !c.trim().is_empty())
    {
        bundle["windows"] = serde_json::json!({ "signCommand": command });
    }
    serde_json::json!({ "bundle": bundle })
}

/// The public release's text: the changelog notes, then how to install and update.
pub(crate) fn release_body(notes: &str, version: &Version, winget: &WingetConfig) -> String {
    let id = &winget.package_identifier;
    format!(
        "{}\n\n## Install\n\nWith winget: `winget install --id {id}` (update: `winget upgrade --id \
         {id}`), or run `{}` below. `SHA256SUMS` lists the installer's SHA-256.\n",
        notes.trim_end(),
        installer_name(version)
    )
}

/// One changelog section from the commit subjects since the last tag (Conventional Commits:
/// `feat`, `fix`, `perf` are listed; the rest is internal).
pub(crate) fn changelog_section(
    version: &Version,
    date: &str,
    subjects: &[String],
    since: Option<&str>,
) -> String {
    let mut groups: [(&str, &str, Vec<String>); 3] = [
        ("feat", "Features", Vec::new()),
        ("fix", "Fixes", Vec::new()),
        ("perf", "Performance", Vec::new()),
    ];
    for subject in subjects {
        let Some((head, text)) = subject.split_once(": ") else {
            continue;
        };
        let head = head.trim_end_matches('!');
        let (kind, scope) = match head.split_once('(') {
            Some((kind, scope)) => (kind, Some(scope.trim_end_matches(')'))),
            None => (head, None),
        };
        if let Some(group) = groups.iter_mut().find(|(k, ..)| *k == kind) {
            let line = match scope {
                Some(scope) => format!("- **{scope}:** {text}"),
                None => format!("- {text}"),
            };
            if !group.2.contains(&line) {
                group.2.push(line);
            }
        }
    }
    let mut out = format!("## [{version}] - {date}\n");
    if since.is_none() {
        out.push_str("\nThe first release of WolfCmd.\n");
    }
    for (_, title, lines) in &groups {
        if !lines.is_empty() {
            let _ = write!(out, "\n### {title}\n");
            for line in lines {
                out.push_str(line);
                out.push('\n');
            }
        }
    }
    if since.is_some() && groups.iter().all(|(.., lines)| lines.is_empty()) {
        out.push_str("\nMaintenance release.\n");
    }
    out
}

pub(crate) const CHANGELOG_HEADER: &str = "# Changelog\n\nWolfCmd releases (generated by `pnpm release`; edit a section before `publish` to change its notes).\n";

/// `CHANGELOG.md` with `section` as the newest entry, replacing a section of the same version.
pub(crate) fn insert_changelog(existing: Option<&str>, version: &Version, section: &str) -> String {
    let existing = existing.unwrap_or(CHANGELOG_HEADER);
    let mut kept = String::new();
    let mut skipping = false;
    let mut header = String::new();
    let mut seen_section = false;
    let marker = format!("## [{version}]");
    for line in existing.split_inclusive('\n') {
        if line.starts_with("## [") {
            seen_section = true;
            skipping = line.starts_with(&marker);
        }
        if skipping {
            continue;
        }
        if seen_section {
            kept.push_str(line);
        } else {
            header.push_str(line);
        }
    }
    let header = header.trim_end();
    let mut out = format!("{header}\n\n{}", section.trim_end());
    if !kept.trim().is_empty() {
        out.push_str("\n\n");
        out.push_str(kept.trim_end());
    }
    out.push('\n');
    out
}

/// The notes of `version` in `CHANGELOG.md` (the section without its heading).
pub(crate) fn release_notes(changelog: &str, version: &Version) -> Option<String> {
    let marker = format!("## [{version}]");
    let start = changelog.find(&marker)?;
    let body = &changelog[start..];
    let body = body.split_once('\n').map_or("", |(_, rest)| rest);
    let end = body.find("\n## [").map_or(body.len(), |i| i + 1);
    Some(body[..end].trim().to_owned())
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .fold(String::with_capacity(64), |mut out, b| {
            let _ = write!(out, "{b:02x}");
            out
        })
}

/// UTC `("YYYY-MM-DD", "YYYY-MM-DDTHH:MM:SSZ")` for Unix seconds.
pub(crate) fn utc_date(secs: u64) -> (String, String) {
    let days = i64::try_from(secs / 86_400).unwrap_or(0);
    let rest = secs % 86_400;
    let (h, m, s) = (rest / 3600, (rest % 3600) / 60, rest % 60);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (
        format!("{year:04}-{month:02}-{day:02}"),
        format!("{year:04}-{month:02}-{day:02}T{h:02}:{m:02}:{s:02}Z"),
    )
}

// ---------------------------------------------------------------------------------------
// Winget manifests

/// The winget manifest schema the files follow (1.6.0: accepted by `microsoft/winget-pkgs`
/// and by every winget client since 1.6).
pub(crate) const WINGET_MANIFEST_VERSION: &str = "1.6.0";
/// The default locale's manifest.
pub(crate) const WINGET_LOCALE: &str = "en-US";
/// `release/vX.Y.Z/winget/`: written by `publish` and `winget`, never part of the build's
/// manifest (it holds the public download address, which `build` doesn't need).
pub(crate) const WINGET_DIR: &str = "winget";

/// One file of a winget manifest set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WingetFile {
    pub(crate) name: String,
    pub(crate) text: String,
}

/// What one version's winget manifests need from the build.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WingetRelease<'a> {
    pub(crate) version: &'a Version,
    /// The public repository the releases go to (`owner/name`).
    pub(crate) public_repo: &'a str,
    /// The installer's SHA-256 (any case; winget's files carry it uppercase).
    pub(crate) installer_sha256: &'a str,
    /// `YYYY-MM-DD`.
    pub(crate) release_date: &'a str,
}

/// The multi-file manifest set for one version (version, installer, default locale), in
/// the layout `microsoft/winget-pkgs` takes: `<Id>.yaml`, `<Id>.installer.yaml`,
/// `<Id>.locale.en-US.yaml`. The installer is Tauri's per-user NSIS one (`nullsoft`, `/S`).
pub(crate) fn winget_manifests(config: &WingetConfig, release: &WingetRelease) -> Vec<WingetFile> {
    let id = config.package_identifier.as_str();
    let version = release.version.to_string();
    let schema = |kind: &str| {
        format!(
            "# Written by WolfCmd's release tool (pnpm release winget {version}).\n\
             # yaml-language-server: $schema=https://aka.ms/winget-manifest.{kind}.{WINGET_MANIFEST_VERSION}.schema.json\n\n"
        )
    };
    let head = format!(
        "PackageIdentifier: {}\nPackageVersion: {}\n",
        yaml(id),
        yaml(&version)
    );
    let tail =
        |kind: &str| format!("ManifestType: {kind}\nManifestVersion: {WINGET_MANIFEST_VERSION}\n");

    let version_file = format!(
        "{}{head}DefaultLocale: {WINGET_LOCALE}\n{}",
        schema("version"),
        tail("version")
    );

    let url = download_url(
        release.public_repo,
        release.version,
        &installer_name(release.version),
    );
    let installer_file = format!(
        "{}{head}InstallerLocale: {WINGET_LOCALE}\n\
         InstallerType: nullsoft\n\
         Scope: user\n\
         InstallModes:\n- interactive\n- silent\n- silentWithProgress\n\
         InstallerSwitches:\n  Silent: /S\n  SilentWithProgress: /S\n\
         UpgradeBehavior: install\n\
         ReleaseDate: {}\n\
         Installers:\n\
         - Architecture: x64\n  InstallerUrl: {}\n  InstallerSha256: {}\n{}",
        schema("installer"),
        yaml(release.release_date),
        yaml(&url),
        release.installer_sha256.to_ascii_uppercase(),
        tail("installer")
    );

    let owner = release
        .public_repo
        .split('/')
        .next()
        .unwrap_or(release.public_repo);
    let mut locale = format!(
        "{}{head}PackageLocale: {WINGET_LOCALE}\n\
         Publisher: {}\n\
         PublisherUrl: {}\n\
         PackageName: {}\n\
         PackageUrl: {}\n\
         License: {}\n\
         ShortDescription: {}\n",
        schema("defaultLocale"),
        yaml(&config.publisher),
        yaml(&repo_page(owner)),
        yaml(&config.package_name),
        yaml(&repo_page(release.public_repo)),
        yaml(&config.license),
        yaml(&config.short_description),
    );
    if let Some(url) = config
        .license_url
        .as_deref()
        .filter(|u| !u.trim().is_empty())
    {
        let _ = writeln!(locale, "LicenseUrl: {}", yaml(url));
    }
    if let Some(moniker) = config.moniker.as_deref().filter(|m| !m.trim().is_empty()) {
        let _ = writeln!(locale, "Moniker: {}", yaml(moniker));
    }
    if !config.tags.is_empty() {
        locale.push_str("Tags:\n");
        for tag in &config.tags {
            let _ = writeln!(locale, "- {}", yaml(tag));
        }
    }
    let _ = writeln!(
        locale,
        "ReleaseNotesUrl: {}",
        yaml(&release_page(release.public_repo, release.version))
    );
    locale.push_str(&tail("defaultLocale"));

    vec![
        WingetFile {
            name: format!("{id}.yaml"),
            text: version_file,
        },
        WingetFile {
            name: format!("{id}.installer.yaml"),
            text: installer_file,
        },
        WingetFile {
            name: format!("{id}.locale.{WINGET_LOCALE}.yaml"),
            text: locale,
        },
    ]
}

/// Where the version's files go in `microsoft/winget-pkgs`:
/// `manifests/<first letter, lowercase>/<Publisher>/<Name…>/<version>`.
pub(crate) fn winget_pkgs_folder(package_identifier: &str, version: &Version) -> String {
    let first = package_identifier
        .chars()
        .next()
        .map_or('_', |c| c.to_ascii_lowercase());
    format!(
        "manifests/{first}/{}/{version}",
        package_identifier.replace('.', "/")
    )
}

/// A YAML scalar: plain when that reads back as the same string, else single-quoted.
fn yaml(value: &str) -> String {
    let plain = value
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric())
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/' | ':' | '+'))
        && !value.contains(": ")
        && !value.ends_with(':')
        && value.parse::<f64>().is_err()
        && !matches!(
            value.to_ascii_lowercase().as_str(),
            "true" | "false" | "yes" | "no" | "on" | "off" | "null" | "y" | "n"
        );
    if plain {
        value.to_owned()
    } else {
        format!("'{}'", value.replace('\'', "''"))
    }
}

/// What to do with the manifests (the tool never submits or pushes anything).
pub(crate) fn winget_instructions(
    config: &WingetConfig,
    version: &Version,
    folder: &str,
    installer_url: &str,
) -> String {
    let id = &config.package_identifier;
    let target = winget_pkgs_folder(id, version);
    format!(
        "Winget manifests for WolfCmd {version}: {folder}\n\
         They point at {installer_url}\n\
         (a public release: `pnpm release publish {version}` makes it).\n\
         \n\
         1. Check them (optional; winget is part of Windows):\n\
         \x20    winget validate --manifest \"{folder}\"\n\
         \x20    winget install --manifest \"{folder}\"   (a test install; once, as admin: winget settings --enable LocalManifestFiles)\n\
         \n\
         2. Submit them to microsoft/winget-pkgs (a pull request reviewed by Microsoft's bots and moderators;\n\
         \x20  nothing here submits). Either:\n\
         \x20    wingetcreate submit --token <GitHub token> \"{folder}\"\n\
         \x20  (wingetcreate: winget install Microsoft.WingetCreate; the token needs public_repo, it forks\n\
         \x20  winget-pkgs for you), or by hand: fork github.com/microsoft/winget-pkgs, copy the three files to\n\
         \x20  {target}/, commit, open a pull request.\n\
         \x20  Later versions the same way, or: wingetcreate update {id} --version {version} --urls {installer_url} --submit\n\
         \n\
         3. Once the pull request is merged (hours to a few days), installs get it with:\n\
         \x20    winget upgrade --id {id}\n\
         \x20  and new installs with: winget install --id {id}\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    fn v(text: &str) -> Version {
        Version::parse(text).unwrap()
    }

    fn config() -> Config {
        parse_config(include_str!("../config.json")).unwrap()
    }

    #[test]
    fn the_steps_parse_with_their_own_flags() {
        assert_eq!(
            parse_command(&args(&["--", "build", "0.2.0"])).unwrap(),
            Command::Build {
                version: v("0.2.0"),
                allow_dirty: false
            }
        );
        assert_eq!(
            parse_command(&args(&["try", "--copy-data"])).unwrap(),
            Command::Try {
                version: None,
                install: false,
                copy_data: true
            }
        );
        assert_eq!(
            parse_command(&args(&["publish", "--version=v1.0.0", "--draft"])).unwrap(),
            Command::Publish {
                version: v("1.0.0"),
                draft: true
            }
        );
        assert_eq!(
            parse_command(&args(&["publish", "1.0.0"])).unwrap(),
            Command::Publish {
                version: v("1.0.0"),
                draft: false
            }
        );
        assert_eq!(
            parse_command(&args(&["winget", "1.0.0"])).unwrap(),
            Command::Winget {
                version: v("1.0.0")
            }
        );
        assert!(parse_command(&args(&["winget"])).is_err(), "no version");
        assert!(parse_command(&args(&["winget", "1.0.0", "--submit"])).is_err());
        assert!(parse_command(&args(&["publish"])).is_err(), "no version");
        assert!(parse_command(&args(&["build", "1.0.0", "--draft"])).is_err());
        assert!(parse_command(&args(&["publish", "1.0.0", "--push-tag"])).is_err());
        assert!(parse_command(&args(&["try", "--install", "--copy-data"])).is_err());
        assert!(parse_command(&args(&["ship", "1.0.0"])).is_err());
        assert!(parse_command(&args(&[])).is_err());
    }

    #[test]
    fn publish_refuses_anything_but_the_built_files() {
        let manifest = Manifest {
            version: "0.2.0".into(),
            commit: "abc".into(),
            dirty: false,
            built: "2026-10-11T14:03:07Z".into(),
            files: vec![
                FileEntry {
                    path: "WolfCmd_0.2.0_x64-setup.exe".into(),
                    sha256: "aa".into(),
                    size: 1,
                },
                FileEntry {
                    path: "app/WolfCmd.exe".into(),
                    sha256: "bb".into(),
                    size: 1,
                },
            ],
        };
        let same = vec![
            ("WolfCmd_0.2.0_x64-setup.exe".to_owned(), "aa".to_owned()),
            ("app/WolfCmd.exe".to_owned(), "bb".to_owned()),
        ];
        assert_eq!(verify(&manifest, &same), Vec::<String>::new());
        let changed = vec![
            ("WolfCmd_0.2.0_x64-setup.exe".to_owned(), "zz".to_owned()),
            ("extra.txt".to_owned(), "cc".to_owned()),
        ];
        assert_eq!(
            verify(&manifest, &changed),
            [
                "WolfCmd_0.2.0_x64-setup.exe changed since the build",
                "app/WolfCmd.exe is missing",
                "extra.txt was not part of the build"
            ]
        );
        // The installer and its sums, nothing for an updater.
        let names = uploads(&v("0.2.0"));
        assert_eq!(names, ["WolfCmd_0.2.0_x64-setup.exe", "SHA256SUMS"]);
        assert_eq!(sums(&manifest, &names), "aa  WolfCmd_0.2.0_x64-setup.exe\n");
        assert_eq!(
            newest(&args(&["v0.2.0", "v0.10.0", "notes", "v0.9.1"])),
            Some(v("0.10.0"))
        );
        // A manifest with an updater's `signed` field still reads.
        let old: Manifest = serde_json::from_str(
            r#"{ "version": "0.4.1", "commit": "abc", "dirty": false, "built": "x", "signed": true, "files": [] }"#,
        )
        .unwrap();
        assert_eq!(old.version, "0.4.1");
    }

    #[test]
    fn versions_parse_and_order_like_semver() {
        assert_eq!(v("v0.2.0").to_string(), "0.2.0");
        assert_eq!(v("1.4.0-beta.2").tag(), "v1.4.0-beta.2");
        assert!(v("0.10.0") > v("0.9.9"));
        assert!(v("1.0.0") > v("1.0.0-beta.1"));
        assert!(v("1.0.0-beta.2") > v("1.0.0-beta.1"));
        for bad in ["1.0", "1.0.0.0", "01.0.0", "1.x.0", "1.0.0-", "1.0.0-a b"] {
            assert!(Version::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn version_bumps_touch_only_the_package_version() {
        let conf = "{\n  \"productName\": \"WolfCmd\",\n  \"version\": \"0.1.0\",\n  \"plugins\": { \"x\": { \"version\": \"0.1.0\" } }\n}\n";
        let bumped = bump_json_version(conf, "0.1.0", "0.2.0").unwrap();
        assert!(bumped.contains("\"version\": \"0.2.0\",\n"));
        assert!(
            bumped.contains("{ \"version\": \"0.1.0\" }"),
            "only the first"
        );
        assert!(bump_json_version(conf, "9.9.9", "1.0.0").is_err());

        let cargo = "[package]\nname = \"wcmd-app\"\nversion = \"0.1.0\"\n\n[dependencies]\nfoo = { version = \"0.1.0\" }\n";
        let bumped = bump_cargo_version(cargo, "0.1.0", "0.2.0").unwrap();
        assert!(bumped.contains("[package]\nname = \"wcmd-app\"\nversion = \"0.2.0\"\n"));
        assert!(bumped.contains("foo = { version = \"0.1.0\" }"));
        let tool = "[package]\nname = \"codemap\"\nversion = \"0.0.0\"\n";
        assert_eq!(bump_cargo_version(tool, "0.1.0", "0.2.0"), None);
        let workspace = "[workspace]
members = []

[workspace.package]
version = \"0.1.0\"
edition = \"2024\"

[workspace.dependencies]
foo = \"0.1.0\"
";
        let bumped = bump_cargo_version(workspace, "0.1.0", "0.2.0").unwrap();
        assert!(bumped.contains(
            "[workspace.package]
version = \"0.2.0\"
"
        ));
        assert!(bumped.contains("foo = \"0.1.0\""));
    }

    #[test]
    fn config_releases_from_the_public_source_repo() {
        let config = config();
        assert_eq!(config.release.source_repo, "wolfknight949/wolfcmd");
        assert_eq!(config.release.source_remote, "origin");
        assert_eq!(config.release.public_repo, "wolfknight949/wolfcmd");
        assert!(config.release.same_repo());
        assert_eq!(config.winget.package_identifier, "Wolfknight949.WolfCmd");
        assert_eq!(config.winget.publisher, "wolfknight949");
        assert_eq!(config.winget.license, "MIT");
        assert_eq!(config.signing.windows_sign_command, None);
        let base = r#"{ "release": { "sourceRepo": "a/b", "publicRepo": "a/c" },
            "winget": { "packageIdentifier": "A.B", "publisher": "a", "packageName": "B",
                        "license": "MIT", "shortDescription": "x" } }"#;
        assert!(parse_config(base).is_ok());
        // The releases may go to the source repository itself (publish checks it is public).
        let same = parse_config(&base.replace("a/c", "A/B")).unwrap();
        assert!(same.release.same_repo());
        assert!(!parse_config(base).unwrap().release.same_repo());
        assert_eq!(same.winget.license_url, None);
        assert!(parse_config(&base.replace("a/c", "nope")).is_err());
        assert!(parse_config(&base.replace("\"A.B\"", "\"AB\"")).is_err());
        assert!(parse_config(&base.replace("\"x\"", "\" \"")).is_err());
        assert!(
            parse_config(&base.replace("\"x\" }", "\"x\", \"tags\": [\"two words\"] }")).is_err()
        );
    }

    #[test]
    fn a_draft_is_created_on_the_built_commit_only_in_the_source_repo() {
        let base = r#"{ "release": { "sourceRepo": "a/b", "publicRepo": "a/c" },
            "winget": { "packageIdentifier": "A.B", "publisher": "a", "packageName": "B",
                        "license": "MIT", "shortDescription": "x" } }"#;
        let separate = parse_config(base).unwrap().release;
        assert_eq!(separate.draft_target("abc123"), None);
        assert_eq!(config().release.draft_target("abc123"), Some("abc123"));
    }

    #[test]
    fn the_app_has_no_updater_and_links_the_public_releases() {
        // The committed app config and the release config agree.
        let conf = include_str!("../../../crates/wcmd-app/tauri.conf.json");
        assert_eq!(app_config_problems(conf, &config()), Vec::<String>::new());
        assert!(app_version(conf).is_ok());
        let with_updater = r#"{ "plugins": { "updater": {} },
            "bundle": { "homepage": "https://github.com/wolfknight949/wolfcmd-releases" } }"#;
        assert_eq!(app_config_problems(with_updater, &config()).len(), 2);
    }

    #[test]
    fn signing_is_pluggable_and_off_by_default_and_nothing_is_built_for_an_updater() {
        let unsigned = release_tauri_config(&SigningConfig::default());
        assert_eq!(
            unsigned,
            serde_json::json!({ "bundle": { "createUpdaterArtifacts": false } })
        );
        let signed = release_tauri_config(&SigningConfig {
            windows_sign_command: Some("trusted-signing-cli -e x %1".into()),
        });
        assert_eq!(signed["bundle"]["createUpdaterArtifacts"], false);
        assert_eq!(
            signed["bundle"]["windows"]["signCommand"],
            "trusted-signing-cli -e x %1"
        );
    }

    #[test]
    fn changelog_groups_conventional_commits_and_replaces_its_own_section() {
        let subjects = args(&[
            "feat(release): local releases",
            "fix(layout): focus after close",
            "fix(layout): focus after close",
            "docs(process): notes",
            "perf: faster start",
            "Merge branch 'x'",
        ]);
        let section = changelog_section(&v("0.2.0"), "2026-10-11", &subjects, Some("v0.1.0"));
        assert_eq!(
            section,
            "## [0.2.0] - 2026-10-11\n\n### Features\n- **release:** local releases\n\n### Fixes\n- **layout:** focus after close\n\n### Performance\n- faster start\n"
        );
        let first = changelog_section(&v("0.1.0"), "2026-10-01", &[], None);
        assert!(first.contains("The first release"));

        let log = insert_changelog(None, &v("0.1.0"), &first);
        let log = insert_changelog(Some(&log), &v("0.2.0"), &section);
        assert!(log.starts_with("# Changelog\n"));
        assert!(log.find("## [0.2.0]").unwrap() < log.find("## [0.1.0]").unwrap());
        // A second dry run of the same version replaces its section.
        let again = insert_changelog(
            Some(&log),
            &v("0.2.0"),
            "## [0.2.0] - 2026-10-12\n\nRedone.\n",
        );
        assert_eq!(again.matches("## [0.2.0]").count(), 1);
        assert!(again.contains("Redone.") && again.contains("## [0.1.0]"));
        assert_eq!(release_notes(&again, &v("0.2.0")).unwrap(), "Redone.");
        assert!(
            release_notes(&again, &v("0.1.0"))
                .unwrap()
                .contains("first release")
        );
        assert_eq!(release_notes(&again, &v("9.0.0")), None);
    }

    #[test]
    fn hashes_and_dates() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(utc_date(1_791_727_387).1, "2026-10-11T14:03:07Z");
    }

    #[test]
    fn the_public_release_says_how_to_install_and_where_files_are() {
        let version = v("0.5.0");
        assert_eq!(
            download_url("o/r", &version, &installer_name(&version)),
            "https://github.com/o/r/releases/download/v0.5.0/WolfCmd_0.5.0_x64-setup.exe"
        );
        assert_eq!(
            release_page("o/r", &version),
            "https://github.com/o/r/releases/tag/v0.5.0"
        );
        let body = release_body("### Fixes\n- one\n", &version, &config().winget);
        assert!(body.starts_with("### Fixes\n- one\n\n## Install"), "{body}");
        assert!(body.contains("winget install --id Wolfknight949.WolfCmd"));
        assert!(body.contains("WolfCmd_0.5.0_x64-setup.exe"));
    }

    fn assets(list: &[(&str, u64)]) -> Vec<Asset> {
        list.iter()
            .map(|(name, size)| Asset {
                name: (*name).to_owned(),
                size: *size,
            })
            .collect()
    }

    #[test]
    fn a_release_is_found_by_tag_among_the_drafts_and_a_rerun_uploads_what_is_missing() {
        let list = r#"[
            { "tag_name": "v0.3.0", "draft": true, "assets": [] },
            { "tag_name": "v0.2.0", "draft": true, "assets": [
                { "name": "WolfCmd_0.2.0_x64-setup.exe", "id": 77, "size": 100 },
                { "id": 5 }
            ] },
            { "tag_name": "v0.1.0", "draft": false, "assets": [] }
        ]"#;
        let found = find_release(list, "v0.2.0").unwrap().unwrap();
        assert!(found.draft);
        assert_eq!(
            found.assets,
            assets(&[("WolfCmd_0.2.0_x64-setup.exe", 100)])
        );
        assert!(!find_release(list, "v0.1.0").unwrap().unwrap().draft);
        assert_eq!(find_release(list, "v9.9.9").unwrap(), None);
        assert!(find_release("{}", "v0.2.0").is_err(), "not a list");
        assert!(find_release("oops", "v0.2.0").is_err());
        assert_eq!(
            missing_assets(&uploads(&v("0.2.0")), &found.assets),
            ["SHA256SUMS"]
        );
    }

    #[test]
    fn a_draft_from_another_build_of_the_version_is_noticed() {
        let manifest = Manifest {
            version: "0.2.0".into(),
            commit: "abc".into(),
            dirty: false,
            built: "2026-10-11T14:03:07Z".into(),
            files: vec![FileEntry {
                path: "WolfCmd_0.2.0_x64-setup.exe".into(),
                sha256: "aa".into(),
                size: 100,
            }],
        };
        assert_eq!(
            stale_assets(&manifest, &assets(&[("WolfCmd_0.2.0_x64-setup.exe", 100)])),
            Vec::<String>::new()
        );
        assert_eq!(
            stale_assets(
                &manifest,
                &assets(&[
                    ("WolfCmd_0.2.0_x64-setup.exe", 99),
                    // Unknown sizes and files the build doesn't know are not judged.
                    ("SHA256SUMS", 0),
                    ("notes.txt", 5),
                ])
            ),
            ["WolfCmd_0.2.0_x64-setup.exe"]
        );
    }

    fn winget_set() -> Vec<WingetFile> {
        winget_manifests(
            &config().winget,
            &WingetRelease {
                version: &v("0.5.0"),
                public_repo: "wolfknight949/wolfcmd",
                installer_sha256: "ab12cd",
                release_date: "2026-10-14",
            },
        )
    }

    #[test]
    fn winget_manifests_are_the_three_files_winget_pkgs_takes() {
        let files = winget_set();
        let names: Vec<&str> = files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "Wolfknight949.WolfCmd.yaml",
                "Wolfknight949.WolfCmd.installer.yaml",
                "Wolfknight949.WolfCmd.locale.en-US.yaml"
            ]
        );
        for (file, kind) in files.iter().zip(["version", "installer", "defaultLocale"]) {
            assert!(
                file.text.contains(&format!(
                    "$schema=https://aka.ms/winget-manifest.{kind}.1.6.0.schema.json"
                )),
                "{}",
                file.text
            );
            assert!(
                file.text
                    .contains("PackageIdentifier: Wolfknight949.WolfCmd\n")
            );
            assert!(file.text.contains("PackageVersion: 0.5.0\n"));
            assert!(
                file.text
                    .ends_with(&format!("ManifestType: {kind}\nManifestVersion: 1.6.0\n"))
            );
        }
        assert!(files[0].text.contains("DefaultLocale: en-US\n"));
        assert_eq!(
            winget_pkgs_folder("Wolfknight949.WolfCmd", &v("0.5.0")),
            "manifests/w/Wolfknight949/WolfCmd/0.5.0"
        );
    }

    #[test]
    fn the_installer_is_the_public_per_user_nsis_download_with_its_hash() {
        let installer = &winget_set()[1].text;
        for line in [
            "InstallerType: nullsoft\n",
            "Scope: user\n",
            "InstallerSwitches:\n  Silent: /S\n  SilentWithProgress: /S\n",
            "UpgradeBehavior: install\n",
            "ReleaseDate: 2026-10-14\n",
            "- Architecture: x64\n  InstallerUrl: https://github.com/wolfknight949/wolfcmd/releases/download/v0.5.0/WolfCmd_0.5.0_x64-setup.exe\n  InstallerSha256: AB12CD\n",
        ] {
            assert!(installer.contains(line), "{line}\n---\n{installer}");
        }
        // No command alias: the installer puts nothing on the PATH.
        assert!(!installer.contains("Commands:"));
    }

    #[test]
    fn a_pre_release_is_its_own_winget_package() {
        let winget = config().winget;
        let stable = winget.for_version(&Version::parse("0.7.1").unwrap());
        assert_eq!(stable, winget);
        let beta = winget.for_version(&Version::parse("0.7.1-beta.1").unwrap());
        assert_eq!(beta.package_identifier, "Wolfknight949.WolfCmd.Beta");
        assert_eq!(beta.package_name, "WolfCmd Beta");
        assert_eq!(beta.moniker.as_deref(), Some("wolfcmd-beta"));
        assert_eq!(beta.publisher, winget.publisher);
        assert!(valid_package_identifier(&beta.package_identifier));
    }

    #[test]
    fn the_locale_describes_the_package_and_quotes_what_yaml_would_misread() {
        let locale = &winget_set()[2].text;
        for line in [
            "PackageLocale: en-US\n",
            "Publisher: wolfknight949\n",
            "PublisherUrl: https://github.com/wolfknight949\n",
            "PackageName: WolfCmd\n",
            "PackageUrl: https://github.com/wolfknight949/wolfcmd\n",
            "License: MIT\n",
            "LicenseUrl: https://github.com/wolfknight949/wolfcmd/blob/main/LICENSE\n",
            "Moniker: wolfcmd\n",
            "Tags:\n- terminal\n",
            "ReleaseNotesUrl: https://github.com/wolfknight949/wolfcmd/releases/tag/v0.5.0\n",
        ] {
            assert!(locale.contains(line), "{line}\n---\n{locale}");
        }
        assert!(locale.contains("ShortDescription: '"), "{locale}");
        assert_eq!(yaml("0.5.0"), "0.5.0");
        assert_eq!(yaml("1.0"), "'1.0'", "a number");
        assert_eq!(yaml("yes"), "'yes'", "a bool");
        assert_eq!(yaml("it's: here"), "'it''s: here'");
        assert_eq!(yaml("#tag"), "'#tag'");
        assert_eq!(yaml(""), "''");
    }

    #[test]
    fn package_identifiers_follow_winget_rules() {
        assert!(valid_package_identifier("Wolfknight949.WolfCmd"));
        assert!(valid_package_identifier("A.B.C"));
        for bad in [
            "WolfCmd",
            "A..B",
            "A.B C",
            "A/B.C",
            ".A",
            "A.B.C.D.E.F.G.H.I",
        ] {
            assert!(!valid_package_identifier(bad), "{bad}");
        }
        assert!(!valid_package_identifier(&format!("A.{}", "x".repeat(33))));
    }

    #[test]
    fn the_instructions_say_how_to_submit_and_submit_nothing() {
        let text = winget_instructions(
            &config().winget,
            &v("0.5.0"),
            "C:/r/release/v0.5.0/winget",
            "https://example.com/i.exe",
        );
        assert!(text.contains("winget validate --manifest \"C:/r/release/v0.5.0/winget\""));
        assert!(text.contains("wingetcreate submit"));
        assert!(text.contains("manifests/w/Wolfknight949/WolfCmd/0.5.0/"));
        assert!(text.contains("winget upgrade --id Wolfknight949.WolfCmd"));
        assert!(text.contains("nothing here submits"));
    }
}
