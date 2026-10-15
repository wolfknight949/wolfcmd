//! `app` domain: the window (N-01) and the few things the page can't do itself.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{Manager as _, State, WebviewWindow};

use crate::error::{ErrorKind, WcmdError};
use crate::platform;
use crate::startup;
use crate::watchdog::Watchdog;
use crate::window_bounds::RestoreMaximized;

/// Hover/press state of the native maximize button (`platform/caption.rs`), so the UI can draw
/// it: the HTML button itself doesn't receive the mouse.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, tauri_specta::Event)]
pub(crate) struct CaptionButtonChanged {
    pub(crate) hovered: bool,
    pub(crate) pressed: bool,
}

/// The maximize button's box in CSS pixels, relative to the window's client area.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Type)]
pub(crate) struct CaptionButtonRect {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

/// The UI reports where its maximize button is, so Windows can offer Snap Layouts on it.
#[tauri::command]
#[specta::specta]
pub(crate) fn app_set_maximize_button(
    window: WebviewWindow,
    rect: CaptionButtonRect,
) -> Result<(), WcmdError> {
    Ok(platform::place_maximize_button(&window, rect)?)
}

/// Where the system menu opens, in CSS pixels in the client area.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Type)]
pub(crate) struct ClientPoint {
    pub(crate) x: f64,
    pub(crate) y: f64,
}

/// The window's system menu (Restore, Move, Size, Minimize, Maximize, Close) at a point of
/// the title bar: a right-click there. Runs on the UI thread; returns at once.
#[tauri::command]
#[specta::specta]
pub(crate) fn app_system_menu(window: WebviewWindow, at: ClientPoint) -> Result<(), WcmdError> {
    let target = window.clone();
    window.run_on_main_thread(move || {
        if let Err(error) = platform::show_system_menu(&target, at.x, at.y) {
            tracing::warn!(%error, "the system menu did not open");
        }
    })?;
    Ok(())
}

/// N-01: the window was revealed once (its first frame, or the start fallback). After that the
/// window shows only when the user asks (the tray, a second launch, a notification): a page that
/// loads again (a reload, a renderer crash) or a late fallback never brings a window back that the
/// user hid to the tray.
static REVEALED: AtomicBool = AtomicBool::new(false);

/// Claims the start's one reveal: `true` for the first caller only.
pub(crate) fn claim_first_reveal() -> bool {
    !REVEALED.swap(true, Ordering::SeqCst)
}

/// The window is created hidden and painted with the theme background; the UI calls this once
/// its first frame is painted, so the user never sees an empty window.
#[tauri::command]
#[specta::specta]
pub(crate) fn app_window_ready(window: WebviewWindow) -> Result<(), WcmdError> {
    if claim_first_reveal() && !window.is_visible()? {
        reveal(&window)?;
        tracing::info!(
            since_start_ms = startup::since_start_ms(),
            "N-01: window shown"
        );
    }
    Ok(())
}

/// Shows the window and gives the page keyboard focus; maximized when it was saved so.
pub(crate) fn reveal(window: &WebviewWindow) -> tauri::Result<()> {
    let maximized = window
        .try_state::<RestoreMaximized>()
        .is_some_and(|flag| flag.take());
    if maximized {
        window.maximize()?;
    }
    window.show()?;
    window.set_focus()?;
    platform::focus_webview(window)
}

/// N-01: the window was hidden by its close (`crate::tray`): `tray` when a tray icon brings it
/// back (else the Dock, on macOS). The UI shows its one hint about it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, tauri_specta::Event)]
pub(crate) struct WindowHidden {
    pub(crate) tray: bool,
}

/// N-01: Ctrl+Q (Cmd+Q on macOS): the real quit, like the tray's Quit (`crate::tray::quit`).
#[tauri::command]
#[specta::specta]
pub(crate) fn app_quit(app: tauri::AppHandle) {
    crate::tray::quit(&app);
}

/// N-02: the page is alive (its answer to the watchdog's `window.__wcPing()`, `crate::watchdog`).
#[tauri::command]
#[specta::specta]
pub(crate) async fn app_pong(watchdog: State<'_, Arc<Watchdog>>) -> Result<(), WcmdError> {
    watchdog.answered();
    Ok(())
}

/// A link Ctrl+clicked in a terminal (N-02).
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenLinkArgs {
    /// A URL (`https://…`, `mailto:…`, an OSC 8 link) or a file or folder path.
    pub(crate) target: String,
    /// `path:line:col` links open the editor there.
    #[serde(default)]
    pub(crate) line: Option<u32>,
    #[serde(default)]
    pub(crate) column: Option<u32>,
    /// The terminal's folder, for relative paths.
    #[serde(default)]
    pub(crate) cwd: Option<String>,
}

/// N-02: opens a Ctrl+clicked link (`crate::open::plan`): web and mail addresses in their
/// default app, files in VS Code at the line (or their default app), folders in the file
/// manager. Executables and scripts are only shown in the file manager, never run, so a
/// terminal can never make WolfCmd run a program.
#[tauri::command]
#[specta::specta]
pub(crate) async fn app_open_link(args: OpenLinkArgs) -> Result<(), WcmdError> {
    tauri::async_runtime::spawn_blocking(move || open_link(&args))
        .await
        .map_err(|e| WcmdError::internal("opening the link was interrupted", &e))?
}

fn open_link(args: &OpenLinkArgs) -> Result<(), WcmdError> {
    use crate::open::{OpenAction, RealFs, plan};

    let editor = which::which("code").ok();
    let action = plan(
        &args.target,
        args.line,
        args.column,
        args.cwd.as_deref().map(std::path::Path::new),
        &RealFs,
        editor.is_some(),
    )
    .map_err(|e| WcmdError::new(ErrorKind::InvalidArgument, e.to_string()))?;
    tracing::info!(?action, "N-02: opening a link");
    let result = match action {
        OpenAction::Url(url) => platform::shell_open(&url),
        OpenAction::Default(path) => platform::shell_open(&path.to_string_lossy()),
        OpenAction::Reveal(path) => platform::reveal_path(&path),
        OpenAction::Editor { path, line, column } => match editor {
            Some(code) => platform::background_command(code)
                .arg("--goto")
                .arg(format!("{}:{line}:{column}", path.display()))
                .spawn()
                .map(drop),
            None => platform::shell_open(&path.to_string_lossy()),
        },
    };
    result.map_err(|e| WcmdError::new(ErrorKind::Unavailable, e.to_string()))
}

/// N-02: the clipboard's text for a right-click paste, read in the core so WebView2 never asks
/// for clipboard permission. `None` when it holds no text.
#[tauri::command]
#[specta::specta]
pub(crate) async fn app_clipboard_text() -> Result<Option<String>, WcmdError> {
    Ok(platform::clipboard_text())
}

/// N-04: the native folder picker (Open folder…), opening in `start` when it exists. `None`
/// when the user cancelled.
#[tauri::command]
#[specta::specta]
pub(crate) async fn app_pick_folder(
    window: WebviewWindow,
    title: String,
    start: Option<String>,
) -> Result<Option<String>, WcmdError> {
    tauri::async_runtime::spawn_blocking(move || {
        platform::pick_folder(&window, &title, start.as_deref())
    })
    .await
    .map_err(|e| WcmdError::internal("the folder picker was interrupted", &e))?
    .map_err(|e| WcmdError::new(ErrorKind::Unavailable, e.to_string()))
}

/// N-07: what the Settings dialog's About section shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AboutInfo {
    /// The app's version (`tauri.conf.json`).
    pub(crate) version: String,
    /// The commit this build is from, when built in a git checkout.
    pub(crate) commit: Option<String>,
    /// Where the settings, workspaces and scrollback are kept.
    pub(crate) data_folder: String,
}

/// N-07: the version and the data folder.
#[tauri::command]
#[specta::specta]
pub(crate) fn app_about(app: tauri::AppHandle) -> AboutInfo {
    AboutInfo {
        version: app.package_info().version.to_string(),
        commit: option_env!("WCMD_COMMIT").map(str::to_owned),
        data_folder: crate::state::data_dir().display().to_string(),
    }
}

/// N-07: opens the data folder in the file manager (only that folder; nothing is run).
#[tauri::command]
#[specta::specta]
pub(crate) async fn app_open_data_folder() -> Result<(), WcmdError> {
    let dir = crate::state::data_dir();
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&dir)?;
        platform::shell_open(&dir.display().to_string())
    })
    .await
    .map_err(|e| WcmdError::internal("opening the data folder was interrupted", &e))?
    .map_err(|e| WcmdError::internal("could not open the data folder", &e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn n01_the_window_is_revealed_once_per_start() {
        // The first frame (or the start fallback) claims the one reveal; a later page load or a
        // late fallback never shows a window the user hid to the tray.
        assert!(claim_first_reveal());
        assert!(!claim_first_reveal());
        assert!(!claim_first_reveal());
    }
}
