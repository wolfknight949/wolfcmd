//! macOS and Linux: the same functions as the Windows modules, so the crate builds everywhere.
//! Window chrome that is a Windows thing (Snap Layouts, the system menu, session-end messages)
//! does nothing; links and folders open with the desktop's own opener (`open` on macOS,
//! `xdg-open` on Linux). Native dialogs, the clipboard and local time come with the macOS
//! and Linux ports.

use std::path::Path;
use std::process::Command;

use tauri::WebviewWindow;

use crate::ipc::app::CaptionButtonRect;
use crate::session::WallClock;
use crate::window_bounds::Rect;

#[cfg(target_os = "macos")]
const OPENER: &str = "open";
#[cfg(not(target_os = "macos"))]
const OPENER: &str = "xdg-open";

#[allow(clippy::unnecessary_wraps)]
pub(crate) fn harden_webview(_window: &WebviewWindow) -> tauri::Result<()> {
    Ok(())
}

#[allow(clippy::unnecessary_wraps)]
pub(crate) fn focus_webview(_window: &WebviewWindow) -> tauri::Result<()> {
    Ok(())
}

#[allow(clippy::unnecessary_wraps)]
pub(crate) fn install_snap_overlay(_window: &WebviewWindow) -> tauri::Result<()> {
    Ok(())
}

#[allow(clippy::unnecessary_wraps)]
pub(crate) fn place_maximize_button(
    _window: &WebviewWindow,
    _rect: CaptionButtonRect,
) -> tauri::Result<()> {
    Ok(())
}

#[allow(clippy::unnecessary_wraps)]
pub(crate) fn show_system_menu(_window: &WebviewWindow, _x: f64, _y: f64) -> tauri::Result<()> {
    Ok(())
}

/// N-06: the window asks for attention (the dock bounces on macOS, the urgency hint on Linux).
pub(crate) fn flash_taskbar(window: &WebviewWindow) -> tauri::Result<()> {
    window.request_user_attention(Some(tauri::UserAttentionType::Informational))
}

/// N-06: no system notification on macOS and Linux yet (the attention request only).
#[allow(clippy::unnecessary_wraps)]
pub(crate) fn notify(
    _identifier: &str,
    _title: &str,
    _body: &str,
    _on_click: impl Fn() + Send + Sync + 'static,
) -> std::io::Result<()> {
    Ok(())
}

#[allow(clippy::unnecessary_wraps)]
pub(crate) fn reload_on_process_failure(_window: &WebviewWindow) -> tauri::Result<()> {
    Ok(())
}

/// Logoff and shutdown reach the app as its normal exit here.
#[allow(clippy::unnecessary_wraps)]
pub(crate) fn on_session_end(
    _window: &WebviewWindow,
    _save: impl Fn() + Send + Sync + 'static,
    _cancelled: impl Fn() + Send + Sync + 'static,
) -> tauri::Result<()> {
    Ok(())
}

/// N-01: macOS follows its convention: a window hidden by its close comes back from the Dock
/// icon (no tray icon); Linux uses the tray when the desktop has one, else closing quits.
pub(crate) const DOCK_SHOWS_HIDDEN_WINDOW: bool = cfg!(target_os = "macos");

/// N-01: a click on the Dock icon (macOS's "reopen") shows a hidden window.
#[cfg(target_os = "macos")]
pub(crate) fn is_reopen(event: &tauri::RunEvent) -> bool {
    matches!(event, tauri::RunEvent::Reopen { .. })
}

/// N-01: no Dock here.
#[cfg(not(target_os = "macos"))]
pub(crate) fn is_reopen(_event: &tauri::RunEvent) -> bool {
    false
}

/// No handle to read without the UI thread: the watchdog treats the window as shown.
#[allow(clippy::unnecessary_wraps)]
pub(crate) fn window_handle(_window: &WebviewWindow) -> tauri::Result<isize> {
    Ok(0)
}

pub(crate) fn is_shown(_handle: isize) -> bool {
    true
}

pub(crate) fn window_rect(window: &WebviewWindow) -> tauri::Result<Rect> {
    let position = window.outer_position()?;
    let size = window.outer_size()?;
    Ok(Rect {
        x: position.x.into(),
        y: position.y.into(),
        width: size.width.into(),
        height: size.height.into(),
    })
}

pub(crate) fn place_window(window: &WebviewWindow, rect: Rect) -> tauri::Result<()> {
    let int = |v: i64| i32::try_from(v).unwrap_or(0);
    let size = |v: i64| u32::try_from(v).unwrap_or(1);
    window.set_position(tauri::PhysicalPosition::new(int(rect.x), int(rect.y)))?;
    window.set_size(tauri::PhysicalSize::new(
        size(rect.width),
        size(rect.height),
    ))
}

/// The divider above a restored scrollback says UTC here for now.
pub(crate) fn local_time(_unix_seconds: u64) -> Option<WallClock> {
    None
}

/// No native folder picker yet: as if the user cancelled.
#[allow(clippy::unnecessary_wraps)]
pub(crate) fn pick_folder(
    _window: &WebviewWindow,
    _title: &str,
    _start: Option<&str>,
) -> std::io::Result<Option<String>> {
    Ok(None)
}

/// No clipboard read here yet: right-click pastes nothing (Ctrl+V still pastes).
pub(crate) fn clipboard_text() -> Option<String> {
    None
}

/// Opens a URL, file or folder with the desktop's default handler. Callers decide what may be
/// opened (`crate::open::plan`); it never gets an executable.
pub(crate) fn shell_open(target: &str) -> std::io::Result<()> {
    Command::new(OPENER).arg(target).spawn().map(drop)
}

/// Shows `path` in the file manager (selected on macOS; its folder on Linux), never runs it.
pub(crate) fn reveal_path(path: &Path) -> std::io::Result<()> {
    if cfg!(target_os = "macos") {
        return Command::new(OPENER).arg("-R").arg(path).spawn().map(drop);
    }
    let folder = path.parent().unwrap_or(path);
    Command::new(OPENER).arg(folder).spawn().map(drop)
}

pub(crate) fn background_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    Command::new(program)
}

/// N-10: ends `child` (its own children are not tracked here yet).
pub(crate) fn kill_tree(child: &mut std::process::Child) {
    let _ = child.kill();
}

/// The file has an executable bit: opening it could run it.
pub(crate) fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}
