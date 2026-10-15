//! The window's life beyond what Tauri reports: whether it is on screen (for the page
//! watchdog), a WebView2 process that failed (the page reloads; terminals keep running), and
//! Windows ending the user's session (logoff, restart, update), when nothing is lost only if it
//! is saved right then.

use std::sync::OnceLock;

use tauri::WebviewWindow;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_PROCESS_FAILED_KIND, COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
};
use webview2_com::ProcessFailedEventHandler;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    IsIconic, IsWindowVisible, WM_ENDSESSION, WM_NCDESTROY, WM_QUERYENDSESSION,
};

const SUBCLASS_ID: usize = 0x5743_4D45; // "WCME"

/// What runs when Windows ends the user's session.
struct SessionEnd {
    /// Saves everything (the workspace document and every terminal's scrollback), blocking.
    save: Box<dyn Fn() + Send + Sync>,
    /// The end was cancelled: the session goes on.
    cancelled: Box<dyn Fn() + Send + Sync>,
}

static ON_SESSION_END: OnceLock<SessionEnd> = OnceLock::new();

fn io(error: windows_core::Error) -> tauri::Error {
    tauri::Error::Io(std::io::Error::other(error))
}

/// The window's handle as a plain number, readable from any thread without asking the UI
/// thread (Tauri's own getters wait for it, which a watchdog must not).
pub(crate) fn window_handle(window: &WebviewWindow) -> tauri::Result<isize> {
    Ok(window.hwnd()?.0 as isize)
}

/// Whether the window is visible and not minimized (a hidden page may be throttled, so it is
/// not expected to answer then).
pub(crate) fn is_shown(handle: isize) -> bool {
    let hwnd = HWND(handle as *mut _);
    // SAFETY: both calls only read the state of a window handle; a stale handle gives false.
    unsafe { IsWindowVisible(hwnd).as_bool() && !IsIconic(hwnd).as_bool() }
}

/// N-02: when a WebView2 renderer process crashes or stops responding, the page reloads (the
/// core keeps every terminal; the new page attaches to them). Logged.
pub(crate) fn reload_on_process_failure(window: &WebviewWindow) -> tauri::Result<()> {
    window.with_webview(|webview| {
        let handler = ProcessFailedEventHandler::create(Box::new(|sender, args| {
            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
            if let Some(args) = args {
                // SAFETY: a live event-args object, read during its event on the UI thread.
                unsafe { args.ProcessFailedKind(&raw mut kind)? };
            }
            match kind {
                COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED
                | COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE => {
                    tracing::warn!(kind = kind.0, "N-02: the page's process failed; reloading");
                    if let Some(sender) = sender {
                        // SAFETY: the webview that raised the event, on its UI thread.
                        unsafe { sender.Reload()? };
                    }
                }
                COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED => {
                    tracing::error!("N-02: the WebView2 browser process exited");
                }
                _ => tracing::info!(kind = kind.0, "a WebView2 helper process exited"),
            }
            Ok(())
        }));
        let mut token = 0i64;
        // SAFETY: `with_webview` runs on the UI thread that owns the live controller.
        let added = unsafe {
            webview
                .controller()
                .CoreWebView2()
                .and_then(|core| core.add_ProcessFailed(&handler, &raw mut token))
        };
        if let Err(error) = added {
            tracing::warn!(%error, "page crashes will not reload it");
        }
    })
}

/// N-05: runs `save` when Windows asks whether the session may end (`WM_QUERYENDSESSION`) and
/// when it does end (`WM_ENDSESSION`): Tauri's exit event may never come then. Runs
/// `cancelled` when the end was called off (`WM_ENDSESSION` with `wParam` 0). Call once, on the
/// UI thread.
pub(crate) fn on_session_end(
    window: &WebviewWindow,
    save: impl Fn() + Send + Sync + 'static,
    cancelled: impl Fn() + Send + Sync + 'static,
) -> tauri::Result<()> {
    let hwnd = HWND(window.hwnd()?.0);
    let _ = ON_SESSION_END.set(SessionEnd {
        save: Box::new(save),
        cancelled: Box::new(cancelled),
    });
    // SAFETY: subclassing our own top-level window on its UI thread; the procedure removes
    // itself on WM_NCDESTROY.
    if unsafe { SetWindowSubclass(hwnd, Some(session_proc), SUBCLASS_ID, 0) }.as_bool() {
        Ok(())
    } else {
        Err(io(windows_core::Error::from_thread()))
    }
}

unsafe extern "system" fn session_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    match message {
        // Saved at the question already: some shutdowns never send the end.
        WM_QUERYENDSESSION => save_now("WM_QUERYENDSESSION"),
        WM_ENDSESSION if wparam.0 != 0 => save_now("WM_ENDSESSION"),
        WM_ENDSESSION => {
            if let Some(end) = ON_SESSION_END.get() {
                tracing::info!("N-05: Windows cancelled ending the session");
                (end.cancelled)();
            }
        }
        WM_NCDESTROY => {
            // SAFETY: removing the subclass we installed on this window.
            let _ = unsafe { RemoveWindowSubclass(hwnd, Some(session_proc), SUBCLASS_ID) };
        }
        _ => {}
    }
    // SAFETY: chain to the next handler (the Snap Layouts subclass, then tao's procedure).
    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}

fn save_now(why: &str) {
    if let Some(end) = ON_SESSION_END.get() {
        tracing::info!(message = why, "N-05: Windows is ending the session; saving");
        (end.save)();
    }
}

/// N-01: a window hidden by its close comes back from the tray icon here (macOS: the Dock).
pub(crate) const DOCK_SHOWS_HIDDEN_WINDOW: bool = false;

/// N-01: the Dock's "reopen" (a click on the app's icon) is macOS's; nothing here asks for it.
pub(crate) fn is_reopen(_event: &tauri::RunEvent) -> bool {
    false
}
