//! The OS boundary: everything platform-specific is below this module, behind one set of
//! functions. Windows is the real implementation; `other.rs` gives macOS and Linux the same
//! functions so the crate builds there. `unsafe` is allowed only below this module.

#[cfg(windows)]
mod caption;
#[cfg(windows)]
mod folder_dialog;
#[cfg(windows)]
mod lifecycle;
#[cfg(windows)]
mod local_time;
#[cfg(windows)]
mod notify;
#[cfg(not(windows))]
mod other;
#[cfg(windows)]
mod windows;

#[cfg(windows)]
pub(crate) use caption::{
    install as install_snap_overlay, place as place_maximize_button, show_system_menu,
};
#[cfg(windows)]
pub(crate) use folder_dialog::pick_folder;
#[cfg(windows)]
pub(crate) use lifecycle::{
    DOCK_SHOWS_HIDDEN_WINDOW, is_reopen, is_shown, on_session_end, reload_on_process_failure,
    window_handle,
};
#[cfg(windows)]
pub(crate) use local_time::local_time;
#[cfg(windows)]
pub(crate) use notify::{flash_taskbar, notify};
#[cfg(not(windows))]
pub(crate) use other::{
    DOCK_SHOWS_HIDDEN_WINDOW, background_command, clipboard_text, flash_taskbar, focus_webview,
    harden_webview, install_snap_overlay, is_executable_file, is_reopen, is_shown, kill_tree,
    local_time, notify, on_session_end, pick_folder, place_maximize_button, place_window,
    reload_on_process_failure, reveal_path, shell_open, show_system_menu, window_handle,
    window_rect,
};
#[cfg(windows)]
pub(crate) use windows::{
    background_command, clipboard_text, focus_webview, harden_webview, is_executable_file,
    kill_tree, place_window, reveal_path, shell_open, window_rect,
};
