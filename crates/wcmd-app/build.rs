fn main() {
    // Least privilege: app commands must be granted in capabilities/main.json. Keep this list
    // in sync with `ipc::specta_builder`.
    let manifest = tauri_build::AppManifest::new().commands(&[
        "app_window_ready",
        "app_set_maximize_button",
        "app_system_menu",
        "app_open_link",
        "app_clipboard_text",
        "app_pick_folder",
        "app_pong",
        "app_about",
        "app_open_data_folder",
        "app_quit",
        "pty_list_profiles",
        "pty_open",
        "pty_write",
        "pty_resize",
        "pty_ack",
        "pty_detach",
        "state_load",
        "state_save",
        "settings_load",
        "settings_save",
        "agent_list",
        "agent_command",
        "agent_done",
        "git_worktrees",
        "git_worktree_add",
        "git_worktree_remove",
    ]);
    let attributes = tauri_build::Attributes::new()
        .app_manifest(manifest)
        .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    embed_windows_manifest();
    emit_commit();
    if let Err(error) = tauri_build::try_build(attributes) {
        panic!("tauri build script failed: {error:#}");
    }
}

/// The commit this build is from (`WCMD_COMMIT`, shown in About; left unset outside a git
/// checkout). Rebuilt when HEAD or its branch moves; only
/// existing files are watched (cargo reruns forever on a missing one).
fn emit_commit() {
    let git = |args: &[&str]| -> Option<String> {
        let output = std::process::Command::new("git").args(args).output().ok()?;
        let text = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        (output.status.success() && !text.is_empty()).then_some(text)
    };
    if let Some(commit) = git(&["rev-parse", "--short=10", "HEAD"]) {
        println!("cargo:rustc-env=WCMD_COMMIT={commit}");
    }
    let branch = git(&["symbolic-ref", "-q", "HEAD"]);
    let mut watched = vec!["HEAD".to_owned()];
    watched.extend(branch);
    for name in watched {
        let path = git(&["rev-parse", "--path-format=absolute", "--git-path", &name]);
        if let Some(path) = path.filter(|p| std::path::Path::new(p).exists()) {
            println!("cargo:rerun-if-changed={path}");
        }
    }
}

/// Embeds `windows-app-manifest.xml` into every target of this crate, including examples
/// and tests (see the comment in the manifest for why).
fn embed_windows_manifest() {
    let target = std::env::var("TARGET").unwrap_or_default();
    if !target.contains("windows-msvc") {
        return;
    }
    let dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default();
    let manifest = std::path::Path::new(&dir).join("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    // Treat linker warnings about the manifest as errors so a bad manifest can't ship.
    println!("cargo:rustc-link-arg=/WX");
}
