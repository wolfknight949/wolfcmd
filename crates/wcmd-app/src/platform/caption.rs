//! Windows 11 Snap Layouts for the custom maximize button.
//!
//! Windows shows the Snap Layouts flyout when the window under the cursor answers
//! `WM_NCHITTEST` with `HTMAXBUTTON`. Our maximize button is HTML inside WebView2, whose
//! windows belong to another process, so they can't answer that. Instead:
//!
//! 1. A tiny child window (`overlay`, alpha 1/255, so it is still hit-tested) sits exactly
//!    over the HTML button. It answers `HTTRANSPARENT`, which passes the hit test on to the
//!    main window (same thread).
//! 2. The main window (subclassed) answers `HTMAXBUTTON` for points inside the overlay, and
//!    handles the click itself (maximize/restore).
//! 3. Hover and press states go to the UI as `CaptionButtonChanged`, so the HTML button
//!    still lights up even though the overlay receives the mouse.

use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};

use tauri::{AppHandle, Manager as _, WebviewWindow};
use tauri_specta::Event;
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT, TrackMouseEvent,
};
use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, EnableMenuItem, GetSystemMenu, GetWindowRect, HTMAXBUTTON,
    HTTRANSPARENT, HWND_TOP, IDC_ARROW, IsWindowVisible, IsZoomed, LWA_ALPHA, LoadCursorW,
    MF_BYCOMMAND, MF_ENABLED, MF_GRAYED, PostMessageW, RegisterClassW, SC_CLOSE, SC_MAXIMIZE,
    SC_MINIMIZE, SC_MOVE, SC_RESTORE, SC_SIZE, SW_MAXIMIZE, SW_RESTORE, SWP_NOACTIVATE,
    SWP_SHOWWINDOW, SetLayeredWindowAttributes, SetMenuDefaultItem, SetWindowPos, ShowWindow,
    TPM_NONOTIFY, TPM_RETURNCMD, TPM_RIGHTBUTTON, TrackPopupMenu, WM_NCDESTROY, WM_NCHITTEST,
    WM_NCLBUTTONDOWN, WM_NCLBUTTONUP, WM_NCMOUSELEAVE, WM_NCMOUSEMOVE, WM_SYSCOMMAND, WNDCLASSW,
    WS_CHILD, WS_CLIPSIBLINGS, WS_EX_LAYERED, WS_EX_NOACTIVATE,
};
use windows_core::w;

use crate::ipc::app::{CaptionButtonChanged, CaptionButtonRect};

const SUBCLASS_ID: usize = 0x5743_4D44; // "WCMD"

static APP: OnceLock<AppHandle> = OnceLock::new();
static OVERLAY: AtomicIsize = AtomicIsize::new(0);
static HOVERED: AtomicBool = AtomicBool::new(false);
static PRESSED: AtomicBool = AtomicBool::new(false);

fn overlay() -> Option<HWND> {
    match OVERLAY.load(Ordering::Acquire) {
        0 => None,
        raw => Some(HWND(raw as *mut _)),
    }
}

fn io(error: windows_core::Error) -> tauri::Error {
    tauri::Error::Io(std::io::Error::other(error))
}

/// Creates the overlay and subclasses the main window. Call once, on the UI thread.
pub(crate) fn install(window: &WebviewWindow) -> tauri::Result<()> {
    let parent = HWND(window.hwnd()?.0);
    let _ = APP.set(window.app_handle().clone());
    // SAFETY: standard window-class registration and child-window creation on the UI thread
    // that owns `parent`; every pointer passed lives for the duration of its call.
    unsafe {
        let instance = GetModuleHandleW(None).map_err(io)?;
        let class = WNDCLASSW {
            lpfnWndProc: Some(overlay_proc),
            hInstance: instance.into(),
            lpszClassName: w!("WolfCmdSnapOverlay"),
            hCursor: LoadCursorW(None, IDC_ARROW).map_err(io)?,
            ..Default::default()
        };
        // Zero means "already registered" on a second window; creation below still works.
        RegisterClassW(&raw const class);
        let overlay = CreateWindowExW(
            WS_EX_LAYERED | WS_EX_NOACTIVATE,
            w!("WolfCmdSnapOverlay"),
            None,
            WS_CHILD | WS_CLIPSIBLINGS,
            0,
            0,
            0,
            0,
            Some(parent),
            None,
            Some(instance.into()),
            None,
        )
        .map_err(io)?;
        // Alpha 1, not 0: a fully transparent layered window is not hit-tested at all.
        SetLayeredWindowAttributes(overlay, COLORREF(0), 1, LWA_ALPHA).map_err(io)?;
        OVERLAY.store(overlay.0 as isize, Ordering::Release);
        if !SetWindowSubclass(parent, Some(parent_proc), SUBCLASS_ID, 0).as_bool() {
            return Err(io(windows_core::Error::from_thread()));
        }
    }
    Ok(())
}

/// Moves the overlay over the HTML maximize button (called by the UI on layout changes).
pub(crate) fn place(window: &WebviewWindow, rect: CaptionButtonRect) -> tauri::Result<()> {
    let Some(overlay) = overlay() else {
        return Ok(());
    };
    let scale = window.scale_factor()?;
    #[allow(clippy::cast_possible_truncation)]
    let px = |v: f64| (v * scale).round() as i32;
    // SAFETY: `overlay` is our own live child window.
    unsafe {
        SetWindowPos(
            overlay,
            Some(HWND_TOP), // above the WebView2 windows
            px(rect.x),
            px(rect.y),
            px(rect.width),
            px(rect.height),
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        )
    }
    .map_err(io)
}

/// The
/// window's own system menu at `(x, y)` (CSS pixels in the client area: a right-click on the
/// title bar, or Alt+Space under it), with the items a maximized or normal window offers. The
/// chosen command goes back as `WM_SYSCOMMAND`, so Windows does what it always does. Must run
/// on the UI thread (`TrackPopupMenu` belongs to the window's thread).
pub(crate) fn show_system_menu(window: &WebviewWindow, x: f64, y: f64) -> tauri::Result<()> {
    let hwnd = HWND(window.hwnd()?.0);
    let scale = window.scale_factor()?;
    let origin = window.inner_position()?;
    #[allow(clippy::cast_possible_truncation)]
    let screen = |offset: i32, v: f64| offset + (v * scale).round() as i32;
    let (sx, sy) = (screen(origin.x, x), screen(origin.y, y));
    // SAFETY: `hwnd` is our live main window and this runs on its thread; the menu is the
    // window's own system menu, which Windows owns (never destroyed here).
    unsafe {
        let menu = GetSystemMenu(hwnd, false);
        if menu.is_invalid() {
            return Ok(());
        }
        let maximized = IsZoomed(hwnd).as_bool();
        let set = |id: u32, on: bool| {
            let flags = MF_BYCOMMAND | if on { MF_ENABLED } else { MF_GRAYED };
            let _ = EnableMenuItem(menu, id, flags);
        };
        set(SC_RESTORE, maximized);
        set(SC_MOVE, !maximized);
        set(SC_SIZE, !maximized);
        set(SC_MINIMIZE, true);
        set(SC_MAXIMIZE, !maximized);
        set(SC_CLOSE, true);
        let _ = SetMenuDefaultItem(menu, SC_CLOSE, 0);
        let chosen = TrackPopupMenu(
            menu,
            TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_NONOTIFY,
            sx,
            sy,
            None,
            hwnd,
            None,
        );
        #[allow(clippy::cast_sign_loss)]
        if chosen.0 != 0 {
            PostMessageW(
                Some(hwnd),
                WM_SYSCOMMAND,
                WPARAM(chosen.0 as usize),
                LPARAM(0),
            )
            .map_err(io)?;
        }
    }
    Ok(())
}

fn set_state(hovered: bool, pressed: bool) {
    let was_hovered = HOVERED.swap(hovered, Ordering::AcqRel);
    let was_pressed = PRESSED.swap(pressed, Ordering::AcqRel);
    if (was_hovered, was_pressed) != (hovered, pressed)
        && let Some(app) = APP.get()
    {
        let _ = CaptionButtonChanged { hovered, pressed }.emit(app);
    }
}

/// Whether a screen point (from `WM_NCHITTEST`'s `lParam`) is over the overlay.
fn over_overlay(lparam: LPARAM) -> bool {
    let Some(overlay) = overlay() else {
        return false;
    };
    // GET_X_LPARAM / GET_Y_LPARAM: signed 16-bit (multi-monitor coordinates can be negative).
    #[allow(clippy::cast_possible_truncation)]
    let point = POINT {
        x: i32::from(lparam.0 as i16),
        y: i32::from((lparam.0 >> 16) as i16),
    };
    let mut rect = RECT::default();
    // SAFETY: valid window handle and out-pointer.
    unsafe {
        IsWindowVisible(overlay).as_bool()
            && GetWindowRect(overlay, &raw mut rect).is_ok()
            && point.x >= rect.left
            && point.x < rect.right
            && point.y >= rect.top
            && point.y < rect.bottom
    }
}

/// `HTMAXBUTTON` as it arrives in `wParam` and as a `WM_NCHITTEST` result.
const HT_MAXBUTTON: usize = HTMAXBUTTON as usize;
#[allow(clippy::cast_possible_wrap)] // 9 fits in any isize
const HT_MAXBUTTON_RESULT: LRESULT = LRESULT(HTMAXBUTTON as isize);

unsafe extern "system" fn overlay_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_NCHITTEST {
        // Let the main window decide (it answers HTMAXBUTTON).
        return LRESULT(HTTRANSPARENT as isize);
    }
    // SAFETY: default handling for every other message of our own window.
    unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}

unsafe extern "system" fn parent_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    match message {
        WM_NCHITTEST if over_overlay(lparam) => {
            return HT_MAXBUTTON_RESULT;
        }
        WM_NCMOUSEMOVE if wparam.0 == HT_MAXBUTTON => {
            if !HOVERED.load(Ordering::Acquire) {
                let mut track = TRACKMOUSEEVENT {
                    cbSize: u32::try_from(size_of::<TRACKMOUSEEVENT>()).unwrap_or(0),
                    dwFlags: TME_LEAVE | TME_NONCLIENT,
                    hwndTrack: hwnd,
                    dwHoverTime: 0,
                };
                // SAFETY: valid struct for our own window.
                let _ = unsafe { TrackMouseEvent(&raw mut track) };
            }
            set_state(true, PRESSED.load(Ordering::Acquire));
            return LRESULT(0);
        }
        WM_NCMOUSELEAVE => set_state(false, false),
        // Swallow these: DefWindowProc would paint a classic caption button.
        WM_NCLBUTTONDOWN if wparam.0 == HT_MAXBUTTON => {
            set_state(true, true);
            return LRESULT(0);
        }
        WM_NCLBUTTONUP if wparam.0 == HT_MAXBUTTON => {
            let was_pressed = PRESSED.load(Ordering::Acquire);
            set_state(true, false);
            if was_pressed {
                // SAFETY: our own top-level window.
                unsafe {
                    let _ = ShowWindow(
                        hwnd,
                        if IsZoomed(hwnd).as_bool() {
                            SW_RESTORE
                        } else {
                            SW_MAXIMIZE
                        },
                    );
                }
            }
            return LRESULT(0);
        }
        WM_NCDESTROY => {
            // SAFETY: removing the subclass we installed on this window.
            let _ = unsafe { RemoveWindowSubclass(hwnd, Some(parent_proc), SUBCLASS_ID) };
        }
        _ => {}
    }
    // SAFETY: chain to the next handler (tao's window procedure).
    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}
