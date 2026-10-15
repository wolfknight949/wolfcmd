//! Turns off the WebView2 behaviors that make a web app feel like a web page.

use std::os::windows::ffi::OsStrExt as _;

use tauri::WebviewWindow;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC, ICoreWebView2Controller, ICoreWebView2Settings3,
    ICoreWebView2Settings5, ICoreWebView2Settings6, ICoreWebView2Settings9,
};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::UI::Shell::AssocIsDangerous;
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowRect, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SetWindowPos,
};
use windows_core::{Interface as _, PCWSTR};

use crate::window_bounds::Rect;

/// Disables browser accelerators (F5, Ctrl+R, Ctrl+P, Ctrl+F…), zoom, pinch zoom, swipe
/// navigation and the link status bubble. Keys still reach the page, so a shell gets
/// Ctrl+R and Ctrl+F. Debug builds keep the default context menu for "Inspect".
pub(crate) fn harden_webview(window: &WebviewWindow) -> tauri::Result<()> {
    window.with_webview(|webview| {
        let controller = webview.controller();
        // SAFETY: `with_webview` runs on the UI thread that owns the controller, and the
        // controller stays alive for the duration of this closure.
        if let Err(error) = unsafe { apply_settings(&controller) } {
            tracing::warn!(%error, "could not apply WebView2 settings");
        }
    })
}

/// Gives the WebView2 control keyboard focus. Showing and focusing the window only focuses
/// the outer window, so without this the terminal ignores typing until the user clicks.
pub(crate) fn focus_webview(window: &WebviewWindow) -> tauri::Result<()> {
    window.with_webview(|webview| {
        // SAFETY: runs on the UI thread that owns the live controller (see harden_webview).
        let result = unsafe {
            webview
                .controller()
                .MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC)
        };
        if let Err(error) = result {
            tracing::warn!(%error, "could not focus the webview");
        }
    })
}

/// The window's outer rectangle in physical pixels. Saved and restored as is: Tauri's
/// `set_size` takes an inner size and adds a caption height this frameless window doesn't
/// have, so a round trip through it grew the window.
pub(crate) fn window_rect(window: &WebviewWindow) -> tauri::Result<Rect> {
    let hwnd = HWND(window.hwnd()?.0);
    let mut rect = RECT::default();
    // SAFETY: `hwnd` is this process's own live top-level window; `rect` is a valid out
    // pointer for the duration of the call.
    unsafe { GetWindowRect(hwnd, &raw mut rect) }
        .map_err(|e| tauri::Error::Io(std::io::Error::other(e)))?;
    Ok(Rect {
        x: rect.left.into(),
        y: rect.top.into(),
        width: i64::from(rect.right) - i64::from(rect.left),
        height: i64::from(rect.bottom) - i64::from(rect.top),
    })
}

/// Moves, then sizes the window to `rect` (outer, physical) without showing or
/// activating it. Moving first lets a DPI change between monitors happen before the size
/// is set, so the size isn't rescaled.
pub(crate) fn place_window(window: &WebviewWindow, rect: Rect) -> tauri::Result<()> {
    let hwnd = HWND(window.hwnd()?.0);
    let int = |v: i64| i32::try_from(v).unwrap_or(0);
    let keep = SWP_NOZORDER | SWP_NOACTIVATE;
    // SAFETY: `hwnd` is this process's own live top-level window.
    unsafe {
        SetWindowPos(
            hwnd,
            None,
            int(rect.x),
            int(rect.y),
            0,
            0,
            keep | SWP_NOSIZE,
        )
        .and_then(|()| {
            SetWindowPos(
                hwnd,
                None,
                0,
                0,
                int(rect.width),
                int(rect.height),
                keep | SWP_NOMOVE,
            )
        })
    }
    .map_err(|e| tauri::Error::Io(std::io::Error::other(e)))
}

/// # Safety
/// Must be called on the thread that owns `controller`.
unsafe fn apply_settings(controller: &ICoreWebView2Controller) -> windows_core::Result<()> {
    // SAFETY: COM calls on live interfaces, on the owning thread (see the caller).
    unsafe {
        let settings = controller.CoreWebView2()?.Settings()?;
        settings.SetIsStatusBarEnabled(false)?;
        settings.SetIsZoomControlEnabled(false)?;
        if !cfg!(debug_assertions) {
            settings.SetAreDefaultContextMenusEnabled(false)?;
            settings.SetAreDevToolsEnabled(false)?;
        }
        settings
            .cast::<ICoreWebView2Settings3>()?
            .SetAreBrowserAcceleratorKeysEnabled(false)?;
        settings
            .cast::<ICoreWebView2Settings5>()?
            .SetIsPinchZoomEnabled(false)?;
        settings
            .cast::<ICoreWebView2Settings6>()?
            .SetIsSwipeNavigationEnabled(false)?;
        // No CSS `app-region` captions. With them WebView2 recomputes its
        // native drag regions on our UI thread after every layout change (measured: 27% of
        // the thread for a changing label in a panel, 99% for a changing title bar), which
        // stalled window moves, clicks and selection while agents reported their status. The
        // title bar drags, maximizes and shows the system menu itself (`chrome/window-drag.ts`).
        settings
            .cast::<ICoreWebView2Settings9>()?
            .SetIsNonClientRegionSupportEnabled(false)?;
    }
    Ok(())
}

/// Opens a URL, file or folder with its default handler (`ShellExecuteW` "open").
/// Callers decide what may be opened (`crate::open::plan`); it never gets an executable.
pub(crate) fn shell_open(target: &str) -> std::io::Result<()> {
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    use windows_core::HSTRING;

    let file = HSTRING::from(target);
    // SAFETY: both strings outlive the call; no window owner is needed.
    let result = unsafe {
        ShellExecuteW(
            None,
            &HSTRING::from("open"),
            &file,
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    // ShellExecute returns a value greater than 32 on success.
    if result.0 as usize > 32 {
        Ok(())
    } else {
        Err(std::io::Error::other(format!(
            "could not open {target} (code {})",
            result.0 as usize
        )))
    }
}

/// The clipboard's text (for right-click paste), read in the core so WebView2 never
/// asks for clipboard permission. `None` if there's no text.
pub(crate) fn clipboard_text() -> Option<String> {
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
    use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};

    /// `CF_UNICODETEXT`.
    const UNICODE_TEXT: u32 = 13;
    // SAFETY: the clipboard is opened and closed on this thread; the global memory handle is
    // locked only while its UTF-16 contents are copied, and stays owned by the clipboard.
    unsafe {
        OpenClipboard(None).ok()?;
        let text = GetClipboardData(UNICODE_TEXT).ok().and_then(|handle| {
            let memory = HGLOBAL(handle.0);
            let pointer = GlobalLock(memory).cast::<u16>();
            if pointer.is_null() {
                return None;
            }
            let mut length = 0;
            while *pointer.add(length) != 0 {
                length += 1;
            }
            let text = String::from_utf16_lossy(std::slice::from_raw_parts(pointer, length));
            let _ = GlobalUnlock(memory);
            Some(text)
        });
        let _ = CloseClipboard();
        text
    }
}

/// A process started without a console window flashing up (`code` is a `.cmd`).
pub(crate) fn background_command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    use std::os::windows::process::CommandExt as _;
    /// `CREATE_NO_WINDOW`.
    const NO_WINDOW: u32 = 0x0800_0000;
    let mut command = std::process::Command::new(program);
    command.creation_flags(NO_WINDOW);
    command
}

/// N-10: ends `child` and every process it started (`taskkill /T /F`), while `child` still
/// runs: Git for Windows' `git.exe` starts the real git, which can start a hook, a credential
/// helper or a filter, and ending only the first would leave the others running. Ends at least
/// `child` when `taskkill` fails.
pub(crate) fn kill_tree(child: &mut std::process::Child) {
    use std::process::Stdio;
    let system = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    let taskkill = std::path::Path::new(&system)
        .join("System32")
        .join("taskkill.exe");
    let ended = background_command(taskkill)
        .args(["/T", "/F", "/PID"])
        .arg(child.id().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    if !ended.is_ok_and(|status| status.success()) {
        tracing::warn!("N-10: could not end the process tree; ending the process alone");
    }
    let _ = child.kill();
}

/// Shows `path` selected in Explorer (an executable a link pointed at: shown, never run). The
/// path is quoted inside the switch (`/select,"C:\a,b\x.exe"`): Explorer splits its arguments at
/// commas, and a bare path with one could make it open the part after the comma. Windows paths
/// can't hold a `"`.
pub(crate) fn reveal_path(path: &std::path::Path) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt as _;
    std::process::Command::new("explorer.exe")
        .raw_arg(select_arg(path))
        .spawn()
        .map(drop)
}

/// Explorer's `/select,"<path>"` switch, as one raw argument.
fn select_arg(path: &std::path::Path) -> String {
    format!("/select,\"{}\"", path.display())
}

/// N-02: Windows runs files by their extension, not by a permission bit: besides the list in
/// `crate::open`, any type Windows itself calls dangerous to open (`AssocIsDangerous`: one
/// that runs code, installs or changes settings, as the system and its policies define them).
pub(crate) fn is_executable_file(path: &std::path::Path) -> bool {
    let Some(extension) = path.extension() else {
        return false;
    };
    let dotted: Vec<u16> = std::iter::once(u16::from(b'.'))
        .chain(extension.encode_wide())
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: `dotted` is a NUL-terminated UTF-16 string that outlives the call, which only
    // reads it.
    unsafe { AssocIsDangerous(PCWSTR(dotted.as_ptr())) }.as_bool()
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{is_executable_file, select_arg};

    /// N-02: a revealed path with a comma (Explorer's argument separator) stays one path.
    #[test]
    fn n02_explorer_selects_the_quoted_path() {
        assert_eq!(
            select_arg(Path::new(r"C:\dl\a,b c\setup.exe")),
            r#"/select,"C:\dl\a,b c\setup.exe""#
        );
    }

    /// N-02: a link never runs what Windows calls dangerous to open, listed in `open.rs` or not.
    #[test]
    fn n02_types_windows_calls_dangerous_are_executable() {
        for file in ["setup.exe", "run.BAT", "tool.scr", "add.reg"] {
            assert!(is_executable_file(Path::new(file)), "{file}");
        }
        for file in ["notes.txt", "main.rs", "Makefile"] {
            assert!(!is_executable_file(Path::new(file)), "{file}");
        }
    }
}
