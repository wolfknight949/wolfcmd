//! `release`: builds a WolfCmd release on this PC, runs it from the dev folder for testing,
//! and publishes it to GitHub (and writes its winget manifests) when a maintainer runs
//! `publish`. No CI builds releases; nothing here runs automatically, and nothing here submits
//! to winget.
//!
//! ```text
//! pnpm release build 0.5.0      bump, changelog, commit, build into release/v0.5.0/
//! pnpm release try [0.5.0]      run that WolfCmd.exe with its own test data folder
//! pnpm release publish 0.5.0    exactly those files to GitHub (a maintainer's step)
//! pnpm release winget 0.5.0     the winget manifests again, and how to submit them
//! ```
//!
//! The procedure and the smoke checklist: `docs/process/release.md`.

// A command-line tool: it talks on stdout/stderr.
#![allow(clippy::print_stdout, clippy::print_stderr)]

mod plan;

use std::path::{Path, PathBuf};
use std::process::{Command as Process, ExitCode};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context as _, bail};

use crate::plan::{
    Command, Config, FileEntry, Manifest, SUMS_FILE, Version, WINGET_DIR, WingetRelease,
};

const TAURI_CONF: &str = "crates/wcmd-app/tauri.conf.json";
const CHANGELOG: &str = "CHANGELOG.md";
/// `release/` at the repository root (git-ignored): one folder per built version.
const RELEASE_DIR: &str = "release";
const MANIFEST: &str = "manifest.json";
const NOTES: &str = "notes.md";
/// The runnable copy of the build (`try`).
const APP_DIR: &str = "app";
/// `try`'s own data folder (never part of the manifest).
const TEST_DATA: &str = "test-data";

fn main() -> ExitCode {
    match run() {
        Ok(code) => code,
        Err(error) => {
            eprintln!("release: {error:#}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> anyhow::Result<ExitCode> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty()
        || args
            .iter()
            .any(|a| a == "--help" || a == "-h" || a == "help")
    {
        println!("{}", plan::USAGE);
        return Ok(ExitCode::SUCCESS);
    }
    let command = plan::parse_command(&args)?;
    let root = std::path::absolute(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))?;
    let config = plan::parse_config(&read(&root.join("tools/release/config.json"))?)?;
    match command {
        Command::Build {
            version,
            allow_dirty,
        } => build(&root, &config, &version, allow_dirty),
        Command::Try {
            version,
            install,
            copy_data,
        } => try_build(&root, version, install, copy_data),
        Command::Publish { version, draft } => publish(&root, &config, &version, draft),
        Command::Winget { version } => winget(&root, &config, &version),
    }
}

fn version_dir(root: &Path, version: &Version) -> PathBuf {
    root.join(RELEASE_DIR).join(version.tag())
}

// ---------------------------------------------------------------------------------------
// build

fn build(
    root: &Path,
    config: &Config,
    version: &Version,
    allow_dirty: bool,
) -> anyhow::Result<ExitCode> {
    let conf = read(&root.join(TAURI_CONF))?;
    // No updater in the app, and its support link is the public releases page.
    let problems = plan::app_config_problems(&conf, config);
    if !problems.is_empty() {
        bail!(
            "{}",
            problems.join(
                "
"
            )
        );
    }
    let current = plan::app_version(&conf)?;
    // Before the first release (no `v*` tag) the current version was never published, so the
    // first one may be lower (0.1.0 → 0.1.0-beta.1).
    let released = !git_output(root, &["tag", "--list", "v*"])?
        .trim()
        .is_empty();
    if *version < current && released {
        bail!("{version} is older than the current version {current}");
    }
    let dirty = git_dirty(root)?;
    let unexpected: Vec<&String> = dirty.iter().filter(|p| !is_release_file(p)).collect();
    if !unexpected.is_empty() && !allow_dirty {
        bail!(
            "uncommitted changes would go into the build: {unexpected:?}\n\
             Commit or stash them, or pass --allow-dirty (such a build can be tried, not published)"
        );
    }

    // 1. The version everywhere and the changelog section, committed (locally) so the build
    //    is a commit `publish` can check and tag.
    let mut changed: Vec<String> = dirty
        .iter()
        .filter(|p| is_release_file(p))
        .cloned()
        .collect();
    if *version == current {
        println!("Version {version} is already set (a rebuild)");
    } else {
        changed.extend(bump_versions(root, &conf, &current, version)?);
    }
    write_changelog(root, version)?;
    changed.push(CHANGELOG.to_owned());
    if !allow_dirty {
        commit_release(root, version, &changed)?;
    }
    let commit = git_output(root, &["rev-parse", "HEAD"])?.trim().to_owned();
    let dirty = !git_dirty(root)?.is_empty();

    // 2. Build the installer.
    build_installer(root, config)?;

    // 3. Assemble release/vX.Y.Z: the installer, its sums, a runnable app, the notes.
    let out = version_dir(root, version);
    clear_build(&out)?;
    let installer = plan::installer_name(version);
    let bundle = target_dir(root).join("release/bundle/nsis");
    copy(&bundle.join(&installer), &out.join(&installer))?;
    let notes = plan::release_notes(&read(&root.join(CHANGELOG))?, version)
        .with_context(|| format!("{CHANGELOG} has no section for {version}"))?;
    write(
        &out.join(NOTES),
        &plan::release_body(&notes, version, &config.winget.for_version(version)),
    )?;
    let (_, built) = plan::utc_date(now());
    assemble_app(root, &out.join(APP_DIR))?;
    let mut manifest = Manifest {
        version: version.to_string(),
        commit,
        dirty,
        built,
        files: hash_files(&out)?,
    };
    let names = plan::uploads(version);
    write(&out.join(SUMS_FILE), &plan::sums(&manifest, &names))?;
    manifest.files = hash_files(&out)?;
    write(
        &out.join(MANIFEST),
        &serde_json::to_string_pretty(&manifest)?,
    )?;

    print_built(config, version, &out, &manifest, &names);
    Ok(ExitCode::SUCCESS)
}

fn print_built(
    config: &Config,
    version: &Version,
    out: &Path,
    manifest: &Manifest,
    names: &[String],
) {
    println!("\nBuilt WolfCmd {version} into {}", out.display());
    println!(
        "  commit {}{}",
        &manifest.commit[..12.min(manifest.commit.len())],
        if manifest.dirty {
            " (with uncommitted changes: not publishable)"
        } else {
            ""
        }
    );
    for name in names {
        let size = std::fs::metadata(out.join(name)).map_or(0, |m| m.len());
        println!("  {name}  ({} KiB)", size.div_ceil(1024));
    }
    println!("\nNothing was uploaded. Next:");
    println!(
        "  pnpm release try {version}              run it from the dev folder (own test data)"
    );
    println!("  pnpm release try {version} --copy-data  … starting from a copy of your workspaces");
    println!("  pnpm release try {version} --install    run the installer (uses your real data)");
    println!("  pnpm release publish {version}          publish it (a maintainer's step)");
    if config.signing.windows_sign_command.is_none() {
        println!(
            "\nNote: not Authenticode-signed (signing.windowsSignCommand): SmartScreen warns on first run."
        );
    }
}

/// Files a release build changes itself: versions, the lock file and the changelog.
fn is_release_file(path: &str) -> bool {
    path == TAURI_CONF
        || path == CHANGELOG
        || path == "Cargo.toml"
        || path == "Cargo.lock"
        || (path.starts_with("crates/") && path.ends_with("Cargo.toml"))
}

/// Sets `version` in `tauri.conf.json` and in the workspace `Cargo.toml` (and any crate that
/// has its own), then the lock file. Returns the files changed.
fn bump_versions(
    root: &Path,
    conf: &str,
    current: &Version,
    version: &Version,
) -> anyhow::Result<Vec<String>> {
    let (old, new) = (current.to_string(), version.to_string());
    let mut changed = Vec::new();
    write(
        &root.join(TAURI_CONF),
        &plan::bump_json_version(conf, &old, &new)?,
    )?;
    changed.push(TAURI_CONF.to_owned());
    let root_manifest = root.join("Cargo.toml");
    let manifests = cargo_manifests(&root.join("crates"))?;
    for manifest in std::iter::once(root_manifest).chain(manifests) {
        if let Some(text) = plan::bump_cargo_version(&read(&manifest)?, &old, &new) {
            write(&manifest, &text)?;
            changed.push(relative(root, &manifest));
        }
    }
    run_command(root, "cargo", &["update", "--workspace", "--offline"], &[])
        .or_else(|_| run_command(root, "cargo", &["update", "--workspace"], &[]))?;
    changed.push("Cargo.lock".to_owned());
    println!("Version {current} → {version} in {} files", changed.len());
    Ok(changed)
}

/// Writes the version's `CHANGELOG.md` section from the commits since the last `v*` tag.
fn write_changelog(root: &Path, version: &Version) -> anyhow::Result<()> {
    let since = git_output(root, &["describe", "--tags", "--abbrev=0", "--match", "v*"])
        .ok()
        .map(|t| t.trim().to_owned())
        .filter(|t| !t.is_empty());
    let subjects: Vec<String> = match &since {
        Some(tag) => git_output(root, &["log", "--format=%s", &format!("{tag}..HEAD")])?
            .lines()
            .map(str::to_owned)
            .collect(),
        None => Vec::new(),
    };
    let (date, _) = plan::utc_date(now());
    let section = plan::changelog_section(version, &date, &subjects, since.as_deref());
    let path = root.join(CHANGELOG);
    let existing = std::fs::read_to_string(&path).ok();
    write(
        &path,
        &plan::insert_changelog(existing.as_deref(), version, &section),
    )
}

/// Commits the release files (when something changed): `chore(release): vX.Y.Z`.
fn commit_release(root: &Path, version: &Version, changed: &[String]) -> anyhow::Result<()> {
    let mut add = vec!["add", "--"];
    add.extend(changed.iter().map(String::as_str));
    run_command(root, "git", &add, &[])?;
    let nothing_staged = Process::new("git")
        .args(["diff", "--cached", "--quiet"])
        .current_dir(root)
        .status()
        .is_ok_and(|s| s.success());
    if nothing_staged {
        return Ok(());
    }
    run_command(
        root,
        "git",
        &[
            "commit",
            "-m",
            &format!("chore(release): {}", version.tag()),
        ],
        &[],
    )
}

/// The installer (Tauri builds the app and runs the UI build first).
fn build_installer(root: &Path, config: &Config) -> anyhow::Result<()> {
    let target = target_dir(root);
    let override_path = target.join("tauri.release.json");
    std::fs::create_dir_all(&target)?;
    write(
        &override_path,
        &serde_json::to_string_pretty(&plan::release_tauri_config(&config.signing))?,
    )?;
    run_command(
        root,
        "pnpm",
        &[
            "tauri",
            "build",
            "--config",
            &override_path.display().to_string(),
        ],
        &[],
    )
}

/// Empties a version's folder for a rebuild, keeping its test data.
fn clear_build(out: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(out)?;
    for entry in std::fs::read_dir(out)? {
        let path = entry?.path();
        if path.file_name().is_some_and(|n| n == TEST_DATA) {
            continue;
        }
        if path.is_dir() {
            std::fs::remove_dir_all(&path)?;
        } else {
            std::fs::remove_file(&path)?;
        }
    }
    Ok(())
}

/// A runnable copy of the build: `WolfCmd.exe` with the ConPTY files the installer puts next to it.
fn assemble_app(root: &Path, app: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(app)?;
    copy(
        &target_dir(root).join("release/WolfCmd.exe"),
        &app.join("WolfCmd.exe"),
    )?;
    let conpty = root.join("resources/conpty/x64");
    for name in ["conpty.dll", "OpenConsole.exe"] {
        copy(&conpty.join(name), &app.join(name))?;
    }
    Ok(())
}

/// Cargo's target folder: `CARGO_TARGET_DIR` when set (relative to `root`), else `target`.
fn target_dir(root: &Path) -> PathBuf {
    std::env::var_os("CARGO_TARGET_DIR").map_or_else(|| root.join("target"), |dir| root.join(dir))
}

/// Every file under `out` (paths with `/`), except the manifest, the test data and the winget
/// manifests (written later by `publish` and `winget`).
fn hash_files(out: &Path) -> anyhow::Result<Vec<FileEntry>> {
    let mut files = Vec::new();
    collect(out, out, &mut files)?;
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

fn collect(base: &Path, dir: &Path, files: &mut Vec<FileEntry>) -> anyhow::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        let rel = relative(base, &path);
        if rel == TEST_DATA || rel == MANIFEST || rel == WINGET_DIR {
            continue;
        }
        if path.is_dir() {
            collect(base, &path, files)?;
        } else {
            let bytes = std::fs::read(&path)?;
            files.push(FileEntry {
                path: rel,
                sha256: plan::sha256_hex(&bytes),
                size: bytes.len() as u64,
            });
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------
// try

fn try_build(
    root: &Path,
    version: Option<Version>,
    install: bool,
    copy_data: bool,
) -> anyhow::Result<ExitCode> {
    let names: Vec<String> = std::fs::read_dir(root.join(RELEASE_DIR))
        .map(|read| {
            read.filter_map(Result::ok)
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    let version = version
        .or_else(|| plan::newest(&names))
        .context("no build in release/: run `pnpm release build X.Y.Z` first")?;
    let out = version_dir(root, &version);
    let manifest = load_manifest(&out, &version)?;
    let problems = plan::verify(&manifest, &found_files(&out)?);
    if !problems.is_empty() {
        eprintln!("Warning: release/{} differs from its build:", version.tag());
        for problem in &problems {
            eprintln!("  {problem}");
        }
    }
    if install {
        let installer = out.join(plan::installer_name(&version));
        println!(
            "Running the installer. The installed WolfCmd uses your REAL data folder \
             (%APPDATA%\\WolfCmd)."
        );
        let status = Process::new(&installer).status()?;
        return Ok(if status.success() {
            ExitCode::SUCCESS
        } else {
            ExitCode::FAILURE
        });
    }
    let data = out.join(TEST_DATA);
    if copy_data {
        let real = real_data_dir().context("APPDATA is not set")?;
        if std::fs::remove_dir_all(&data).is_err() && data.exists() {
            bail!(
                "{} is in use: close the WolfCmd you are trying first",
                data.display()
            );
        }
        println!(
            "Copying {} into {} (close WolfCmd first for an exact copy)",
            real.display(),
            data.display()
        );
        copy_data_folder(&real, &data)?;
    }
    std::fs::create_dir_all(&data)?;
    let exe = out.join(APP_DIR).join("WolfCmd.exe");
    let child = Process::new(&exe)
        .current_dir(out.join(APP_DIR))
        .env("WOLFCMD_DATA_DIR", &data)
        .spawn()
        .with_context(|| format!("could not start {}", exe.display()))?;
    println!(
        "WolfCmd {version} is running (pid {}) from {}\nwith its own data folder {}.\nYour \
         workspaces in %APPDATA%\\WolfCmd are not touched. Close it when done; the test data \
         stays for the next try (--copy-data starts over from your real workspaces).",
        child.id(),
        exe.display(),
        data.display()
    );
    Ok(ExitCode::SUCCESS)
}

/// `%APPDATA%\WolfCmd`: the installed app's data folder.
fn real_data_dir() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|base| PathBuf::from(base).join("WolfCmd"))
}

fn copy_data_folder(from: &Path, to: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(to)?;
    if !from.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let name = entry.file_name();
        let path = entry.path();
        if path.is_dir() {
            copy_tree(&path, &to.join(&name))?;
        } else {
            copy(&path, &to.join(&name))?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------
// publish

/// The built release in `out`, after checking it can be published: a clean
/// build whose files are unchanged, of the checked-out commit, which the source repository
/// already has; and a public repository to publish to.
fn publishable(
    root: &Path,
    config: &Config,
    version: &Version,
    out: &Path,
) -> anyhow::Result<Manifest> {
    let tag = version.tag();
    let manifest = load_manifest(out, version)?;
    if manifest.dirty {
        bail!("{tag} was built with uncommitted changes: commit them and build again");
    }
    let problems = plan::verify(&manifest, &found_files(out)?);
    if !problems.is_empty() {
        bail!(
            "release/{tag} is not what was built; build again:\n  {}",
            problems.join("\n  ")
        );
    }
    let head = git_output(root, &["rev-parse", "HEAD"])?.trim().to_owned();
    if head != manifest.commit {
        bail!(
            "the source moved since the build (built from {}, now at {head}): build again, or \
             check out the built commit",
            manifest.commit
        );
    }
    let dirty = git_dirty(root)?;
    if !dirty.is_empty() {
        bail!("the working tree differs from the built commit: {dirty:?}");
    }
    run_command(root, "gh", &["auth", "status"], &[])
        .context("the GitHub CLI must be installed and signed in (`gh auth login`)")?;

    let source = config.release.source_repo.as_str();
    // The release tag belongs to a commit the source repository already has.
    gh_output(
        root,
        &[
            "api",
            &format!("repos/{source}/commits/{}", manifest.commit),
            "--jq",
            ".sha",
        ],
    )
    .with_context(|| {
        format!(
            "the built commit {} is not on github.com/{source}: run `pnpm check`, push it \
             (`git push {} main`) and publish again",
            &manifest.commit[..12.min(manifest.commit.len())],
            config.release.source_remote
        )
    })?;
    // Installers go only to a public repository: the source repository itself when it is
    // public, or a releases repository a maintainer creates once (this tool never creates
    // repositories).
    let public = config.release.public_repo.as_str();
    let visibility = gh_output(
        root,
        &["api", &format!("repos/{public}"), "--jq", ".visibility"],
    )
    .with_context(|| {
        format!(
            "github.com/{public} (release.publicRepo) is missing or not readable: check the \
                 name and `gh auth status` (docs/process/release.md) and publish again"
        )
    })?;
    if visibility.trim() != "public" {
        bail!(
            "github.com/{public} is {}, not public: winget can only download from a public \
             repository (make it public, or set release.publicRepo)",
            visibility.trim()
        );
    }
    Ok(manifest)
}

fn publish(
    root: &Path,
    config: &Config,
    version: &Version,
    draft: bool,
) -> anyhow::Result<ExitCode> {
    let tag = version.tag();
    let out = version_dir(root, version);
    let manifest = publishable(root, config, version, &out)?;
    let public = config.release.public_repo.as_str();
    // A release of this tag already there: a draft (`--draft` earlier, or a run that stopped)
    // is continued; a published one is final.
    let mut release = find_release(root, public, &tag)?;
    if release.as_ref().is_some_and(|r| !r.draft) {
        bail!("a release {tag} already exists on github.com/{public}");
    }

    // 1. A draft with the installer and its sums: nothing is downloadable until the end.
    let files = plan::uploads(version);
    if release.is_none() {
        let target = config.release.draft_target(&manifest.commit);
        create_draft(root, public, target, version, &out, &files)?;
        release = find_release(root, public, &tag)?;
    }
    let info = release.context("the draft release is not on GitHub after creating it")?;
    let stale = plan::stale_assets(&manifest, &info.assets);
    if !stale.is_empty() {
        bail!(
            "the draft {tag} on github.com/{public} holds files from another build ({}): delete \
             the draft on GitHub and publish again",
            stale.join(", ")
        );
    }
    let missing = plan::missing_assets(&files, &info.assets);
    if !missing.is_empty() {
        let paths: Vec<String> = missing
            .iter()
            .map(|name| out.join(name).display().to_string())
            .collect();
        gh_upload(root, public, &tag, &paths)?;
    }

    if draft {
        println!(
            "\nDraft release {tag} on github.com/{public}: nothing is downloadable yet. Run \
             `pnpm release publish {version}` again to tag and publish it."
        );
        return Ok(ExitCode::SUCCESS);
    }

    // 2. The tag on the built commit, pushed to the source repository, then the public release
    //    goes live as the latest one.
    tag_source(root, &tag, &manifest.commit, version)?;
    run_command(
        root,
        "git",
        &["push", &config.release.source_remote, &tag],
        &[],
    )?;
    let mut edit = vec![
        "release",
        "edit",
        tag.as_str(),
        "--repo",
        public,
        "--draft=false",
    ];
    if version.pre.is_none() {
        edit.push("--latest");
    }
    run_command(root, "gh", &edit, &[])?;
    println!(
        "\nPublished {tag} on github.com/{public} and pushed the tag {tag} to {}.",
        config.release.source_repo
    );

    // 3. The winget manifests for this release (nothing is submitted).
    let folder = write_winget(config, version, &out, &manifest)?;
    println!(
        "Wrote the winget manifests into {}.\nNext: `pnpm release winget {version}` says how to \
         submit them.",
        folder.display()
    );
    Ok(ExitCode::SUCCESS)
}

/// The release tagged `tag` (draft or published) in the repository, if any.
fn find_release(root: &Path, repo: &str, tag: &str) -> anyhow::Result<Option<plan::ReleaseInfo>> {
    // The by-tag endpoint doesn't return drafts; the list does.
    let list = gh_output(
        root,
        &["api", &format!("repos/{repo}/releases?per_page=100")],
    )?;
    plan::find_release(&list, tag)
}

/// Creates the draft release for `version` on the public repository with `files` attached,
/// on `target` (the built commit, when the releases go to the source repository). Without a
/// target (a releases repository that holds no source) GitHub puts its tag on that
/// repository's default branch when the release is published.
fn create_draft(
    root: &Path,
    repo: &str,
    target: Option<&str>,
    version: &Version,
    out: &Path,
    files: &[String],
) -> anyhow::Result<()> {
    let tag = version.tag();
    let title = format!("WolfCmd {version}");
    let notes = out.join(NOTES).display().to_string();
    let mut args: Vec<String> = [
        "release",
        "create",
        tag.as_str(),
        "--repo",
        repo,
        "--draft",
        "--title",
        title.as_str(),
        "--notes-file",
        notes.as_str(),
    ]
    .map(str::to_owned)
    .to_vec();
    if let Some(commit) = target {
        args.extend(["--target".to_owned(), commit.to_owned()]);
    }
    // A version like 0.1.0-beta.1 is still a normal GitHub release, never a pre-release
    // (winget reads the manifest it is given, not GitHub's flags).
    args.extend(
        files
            .iter()
            .map(|name| out.join(name).display().to_string()),
    );
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    run_command(root, "gh", &args, &[])
}

/// Attaches `files` to the release `tag` (a draft is found by `gh` too).
fn gh_upload(root: &Path, repo: &str, tag: &str, files: &[String]) -> anyhow::Result<()> {
    let mut args = vec!["release", "upload", tag, "--repo", repo];
    args.extend(files.iter().map(String::as_str));
    run_command(root, "gh", &args, &[])
}

/// Runs `gh` and returns its output; fails with its error text on a non-zero exit.
fn gh_output(root: &Path, args: &[&str]) -> anyhow::Result<String> {
    let output = Process::new(resolve("gh"))
        .args(args)
        .current_dir(root)
        .output()
        .context("could not run gh")?;
    if !output.status.success() {
        bail!(
            "gh {}: {}",
            args.first().copied().unwrap_or_default(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Tags the built commit `vX.Y.Z` locally (an existing tag must point at it).
fn tag_source(root: &Path, tag: &str, commit: &str, version: &Version) -> anyhow::Result<()> {
    if let Ok(target) = git_output(root, &["rev-list", "-n", "1", tag]) {
        if target.trim() == commit {
            return Ok(());
        }
        bail!("the tag {tag} exists on another commit ({})", target.trim());
    }
    run_command(
        root,
        "git",
        &[
            "tag",
            "-a",
            tag,
            "-m",
            &format!("WolfCmd {version}"),
            commit,
        ],
        &[],
    )
}

// ---------------------------------------------------------------------------------------
// winget

/// Writes the version's winget manifests into `release/vX.Y.Z/winget/` (replacing what is
/// there) and returns that folder.
fn write_winget(
    config: &Config,
    version: &Version,
    out: &Path,
    manifest: &Manifest,
) -> anyhow::Result<PathBuf> {
    let installer = plan::installer_name(version);
    let sha = manifest
        .sha256_of(&installer)
        .with_context(|| format!("the build of {version} has no {installer}"))?;
    let (date, _) = plan::utc_date(now());
    let files = plan::winget_manifests(
        &config.winget.for_version(version),
        &WingetRelease {
            version,
            public_repo: &config.release.public_repo,
            installer_sha256: sha,
            release_date: &date,
        },
    );
    let folder = out.join(WINGET_DIR);
    if folder.exists() {
        std::fs::remove_dir_all(&folder)?;
    }
    std::fs::create_dir_all(&folder)?;
    for file in files {
        write(&folder.join(&file.name), &file.text)?;
    }
    Ok(folder)
}

/// `pnpm release winget X.Y.Z`: the manifests again (a changed `config.json` shows up), and
/// how to check and submit them. Local files only: nothing is uploaded, pushed or submitted.
fn winget(root: &Path, config: &Config, version: &Version) -> anyhow::Result<ExitCode> {
    let out = version_dir(root, version);
    let manifest = load_manifest(&out, version)?;
    let problems = plan::verify(&manifest, &found_files(&out)?);
    if !problems.is_empty() {
        bail!(
            "release/{} is not what was built; build again:\n  {}",
            version.tag(),
            problems.join("\n  ")
        );
    }
    let folder = write_winget(config, version, &out, &manifest)?;
    let url = plan::download_url(
        &config.release.public_repo,
        version,
        &plan::installer_name(version),
    );
    println!(
        "{}",
        plan::winget_instructions(
            &config.winget.for_version(version),
            version,
            &folder.display().to_string(),
            &url,
        )
    );
    Ok(ExitCode::SUCCESS)
}

// ---------------------------------------------------------------------------------------
// shared

fn load_manifest(out: &Path, version: &Version) -> anyhow::Result<Manifest> {
    let text = std::fs::read_to_string(out.join(MANIFEST)).with_context(|| {
        format!("no build of {version} in release/: run `pnpm release build {version}` first")
    })?;
    serde_json::from_str(&text).context("release manifest")
}

fn found_files(out: &Path) -> anyhow::Result<Vec<(String, String)>> {
    Ok(hash_files(out)?
        .into_iter()
        .map(|f| (f.path, f.sha256))
        .collect())
}

fn cargo_manifests(dir: &Path) -> anyhow::Result<Vec<PathBuf>> {
    let mut found = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() {
            if path
                .file_name()
                .is_some_and(|n| n == "target" || n == "node_modules")
            {
                continue;
            }
            found.extend(cargo_manifests(&path)?);
        } else if path.file_name().is_some_and(|n| n == "Cargo.toml") {
            found.push(path);
        }
    }
    found.sort();
    Ok(found)
}

fn git_dirty(root: &Path) -> anyhow::Result<Vec<String>> {
    Ok(
        git_output(root, &["status", "--porcelain", "--untracked-files=normal"])?
            .lines()
            .filter_map(|line| line.get(3..))
            .map(|path| path.trim_matches('"').replace('\\', "/"))
            .collect(),
    )
}

fn git_output(root: &Path, args: &[&str]) -> anyhow::Result<String> {
    let output = Process::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .context("git")?;
    if !output.status.success() {
        bail!(
            "git {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Runs a command in `root`, showing its output; fails on a non-zero exit.
fn run_command(
    root: &Path,
    program: &str,
    args: &[&str],
    env: &[(&str, &str)],
) -> anyhow::Result<()> {
    println!("> {program} {}", args.join(" "));
    let status = Process::new(resolve(program))
        .args(args)
        .envs(env.iter().copied())
        .current_dir(root)
        .status()
        .with_context(|| format!("could not run {program}"))?;
    if !status.success() {
        bail!("{program} {} failed ({status})", args.join(" "));
    }
    Ok(())
}

/// On Windows `pnpm` is `pnpm.cmd`: find the real file on `PATH` (std runs `.cmd` files
/// with proper argument quoting when named explicitly).
fn resolve(program: &str) -> PathBuf {
    if cfg!(windows)
        && let Some(path) = std::env::var_os("PATH")
    {
        for dir in std::env::split_paths(&path) {
            for ext in ["exe", "cmd"] {
                let candidate = dir.join(format!("{program}.{ext}"));
                if candidate.is_file() {
                    return candidate;
                }
            }
        }
    }
    PathBuf::from(program)
}

fn copy(from: &Path, to: &Path) -> anyhow::Result<()> {
    if let Some(dir) = to.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::copy(from, to)
        .map(drop)
        .with_context(|| format!("copying {}", from.display()))
}

fn copy_tree(from: &Path, to: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from).with_context(|| format!("reading {}", from.display()))? {
        let path = entry?.path();
        let target = to.join(path.file_name().unwrap_or_default());
        if path.is_dir() {
            copy_tree(&path, &target)?;
        } else {
            copy(&path, &target)?;
        }
    }
    Ok(())
}

fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .display()
        .to_string()
        .replace('\\', "/")
}

fn read(path: &Path) -> anyhow::Result<String> {
    std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))
}

fn write(path: &Path, text: &str) -> anyhow::Result<()> {
    std::fs::write(path, text).with_context(|| format!("writing {}", path.display()))
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}
