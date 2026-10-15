//! `git` domain (N-10): a workspace's git worktrees. Git runs on the blocking pool, never on
//! the UI thread (`crate::git`).

use std::collections::HashSet;
use std::time::Duration;

use tauri::State;

use crate::error::WcmdError;
use crate::git::{self, GitRepository};
use crate::ipc::pty::Host;

/// How long a removal waits for the worktree's terminals to end.
const END_TERMINALS: Duration = Duration::from_secs(5);

async fn blocking<T: Send + 'static>(
    what: &'static str,
    job: impl FnOnce() -> Result<T, WcmdError> + Send + 'static,
) -> Result<T, WcmdError> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|e| WcmdError::internal(what, &e))?
}

/// The worktrees of `folder`'s repository (read when the workspace menu opens, never polled).
/// `None` when the folder isn't in a git repository.
#[tauri::command]
#[specta::specta]
pub(crate) async fn git_worktrees(folder: String) -> Result<Option<GitRepository>, WcmdError> {
    let folder = git::absolute(&folder)?;
    blocking("listing worktrees was interrupted", move || {
        git::worktrees(&folder)
    })
    .await
}

/// Adds a worktree at `path`: a new branch from `folder`'s HEAD (`new_branch`) or an existing
/// branch. Returns its path.
#[tauri::command]
#[specta::specta]
pub(crate) async fn git_worktree_add(
    folder: String,
    branch: String,
    new_branch: bool,
    path: String,
) -> Result<String, WcmdError> {
    let folder = git::absolute(&folder)?;
    blocking("adding the worktree was interrupted", move || {
        git::add(&folder, &branch, new_branch, &path)
    })
    .await
}

/// Removes the worktree at `path` (its branch is kept). Refuses one with uncommitted changes
/// unless `force`. First ends the terminals of `panels` (its workspace's: Windows can't delete a
/// folder a shell stands in), and only after the checks pass, so a refusal leaves them running.
#[tauri::command]
#[specta::specta]
pub(crate) async fn git_worktree_remove(
    host: State<'_, Host>,
    path: String,
    force: bool,
    panels: Vec<String>,
) -> Result<(), WcmdError> {
    let path = git::absolute(&path)?;
    let host = Host::clone(&host);
    blocking("removing the worktree was interrupted", move || {
        let main_root = git::check_removable(&path, force)?;
        let panels: HashSet<String> = panels.into_iter().collect();
        if !host.end_panels(&panels, END_TERMINALS) {
            tracing::warn!("N-10: a worktree terminal did not end in time");
        }
        git::remove(std::path::Path::new(&main_root), &path, force)
    })
    .await
}
