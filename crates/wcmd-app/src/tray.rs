//! N-01: closing the window (its ✕, Alt+F4, the taskbar's Close) hides WolfCmd to the system
//! tray instead of quitting, so its terminals, agents and sessions keep running; Quit (the
//! tray's menu, Ctrl+Q / Cmd+Q through `app_quit`) is the real exit (`lib.rs`: the state
//! flushed, the scrollback saved, the sessions ended). With `window.close_to_tray` off, or
//! where nothing can bring the window back (no tray on that Linux desktop), closing quits as
//! before. macOS keeps its own convention: the red button hides the window, the Dock icon stays
//! and brings it back (`platform::is_reopen`); no tray icon there.
//!
//! Hidden, nothing of the window runs (the watchdog waits: [`hidden`]); Windows ending the
//! session still saves everything (`platform::on_session_end`: a hidden window gets those
//! messages too); a second launch, a click on the finish notification, the tray icon and its
//! Show item bring the window back where it was ([`show`]).

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager as _, WebviewWindow, WindowEvent};
use tauri_specta::Event as _;

use crate::ipc::app::{WindowHidden, reveal};
use crate::ipc::pty::Host;
use crate::ipc::settings::SettingsService;
use crate::platform;

/// Why the window is closing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Request {
    /// The window's own close: its ✕, Alt+F4, the taskbar's Close.
    Close,
    /// The user quit (the tray's Quit, Ctrl+Q): the window goes with the app.
    Quit,
}

/// What a close does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Close {
    /// The window hides; the app keeps running.
    Hide,
    /// The window closes and the app quits.
    Quit,
}

/// N-01: the close decision. `close_to_tray`: the setting; `can_hide`: something can bring the
/// window back (the tray icon is up, or the OS keeps a Dock icon).
pub(crate) fn decide(request: Request, close_to_tray: bool, can_hide: bool) -> Close {
    match request {
        Request::Close if close_to_tray && can_hide => Close::Hide,
        Request::Close | Request::Quit => Close::Quit,
    }
}

/// The user quit: a close now lets the window go.
static QUITTING: AtomicBool = AtomicBool::new(false);
/// The window is hidden to the tray (or the Dock).
static HIDDEN: AtomicBool = AtomicBool::new(false);
/// Something can bring a hidden window back ([`install`]).
static CAN_HIDE: AtomicBool = AtomicBool::new(false);
/// That something is a tray icon (else the Dock).
static IN_TRAY: AtomicBool = AtomicBool::new(false);

/// The window is hidden to the tray: nothing of it is expected to run.
pub(crate) fn hidden() -> bool {
    HIDDEN.load(Ordering::Relaxed)
}

const SHOW_ITEM: &str = "wcmd-tray-show";
const QUIT_ITEM: &str = "wcmd-tray-quit";

/// Sets up where a hidden window lives (the tray icon, or the Dock) and the window's close.
/// Call once, in `setup`.
pub(crate) fn install(window: &WebviewWindow, settings: Arc<SettingsService>) {
    // macOS: the Dock icon brings the window back; elsewhere the tray icon does.
    let can_hide = platform::DOCK_SHOWS_HIDDEN_WINDOW
        || match tray_icon(window.app_handle()) {
            Ok(()) => {
                IN_TRAY.store(true, Ordering::Relaxed);
                true
            }
            Err(error) => {
                tracing::warn!(%error, "N-01: no tray icon; closing the window quits");
                false
            }
        };
    CAN_HIDE.store(can_hide, Ordering::Relaxed);
    let target = window.clone();
    window.on_window_event(move |event| {
        let WindowEvent::CloseRequested { api, .. } = event else {
            return;
        };
        let request = if QUITTING.load(Ordering::Relaxed) {
            Request::Quit
        } else {
            Request::Close
        };
        let close = decide(
            request,
            settings.close_to_tray(),
            CAN_HIDE.load(Ordering::Relaxed),
        );
        if close == Close::Hide {
            api.prevent_close();
            hide(&target);
        }
    });
}

/// The tray icon: the app's icon, "WolfCmd"; a left click shows the window, the right-click
/// menu has Show WolfCmd and Quit WolfCmd.
fn tray_icon(app: &AppHandle) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, SHOW_ITEM, "Show WolfCmd", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, QUIT_ITEM, "Quit WolfCmd", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show_item, &separator, &quit_item])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("WolfCmd")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            SHOW_ITEM => show_main(app),
            QUIT_ITEM => quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// Hides the window; the UI hears of it (`WindowHidden`: the one hint about the tray).
fn hide(window: &WebviewWindow) {
    if let Err(error) = window.hide() {
        tracing::warn!(%error, "N-01: could not hide the window");
        return;
    }
    HIDDEN.store(true, Ordering::Relaxed);
    // A hidden page acknowledges output slowly: no session waits for it meanwhile.
    if let Some(host) = window.try_state::<Host>() {
        host.set_background(true);
    }
    tracing::info!("N-01: the window is hidden; WolfCmd keeps running");
    let event = WindowHidden {
        tray: IN_TRAY.load(Ordering::Relaxed),
    };
    if let Err(error) = event.emit(window) {
        tracing::warn!(%error, "N-01: could not tell the page the window is hidden");
    }
}

/// Shows the window where it was (restored if it was minimized) and gives it the keyboard.
pub(crate) fn show(window: &WebviewWindow) -> tauri::Result<()> {
    // Back from the tray: the sessions wait for their views again, and a view that fell
    // behind catches up from the screen state.
    if HIDDEN.swap(false, Ordering::Relaxed)
        && let Some(host) = window.try_state::<Host>()
    {
        host.set_background(false);
    }
    if window.is_minimized()? {
        window.unminimize()?;
    }
    reveal(window)
}

/// Shows the main window (the tray icon, its Show item, the Dock icon).
pub(crate) fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main")
        && let Err(error) = show(&window)
    {
        tracing::warn!(%error, "N-01: could not show the window");
    }
}

/// N-01: the real quit (the tray's Quit, Ctrl+Q): the app exits through `RunEvent::Exit`, which
/// flushes the state, saves the scrollback and ends the sessions.
pub(crate) fn quit(app: &AppHandle) {
    tracing::info!("N-01: quit");
    quitting();
    app.exit(0);
}

/// The app is ending: a close now lets the window go.
pub(crate) fn quitting() {
    QUITTING.store(true, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn n01_close_hides_to_the_tray_when_the_setting_is_on() {
        assert_eq!(decide(Request::Close, true, true), Close::Hide);
    }

    #[test]
    fn n01_close_quits_when_the_setting_is_off() {
        assert_eq!(decide(Request::Close, false, true), Close::Quit);
    }

    #[test]
    fn n01_close_quits_when_nothing_could_bring_the_window_back() {
        // No tray on this desktop: hiding would lose the window.
        assert_eq!(decide(Request::Close, true, false), Close::Quit);
    }

    #[test]
    fn n01_a_quit_request_always_quits() {
        for close_to_tray in [true, false] {
            for can_hide in [true, false] {
                assert_eq!(
                    decide(Request::Quit, close_to_tray, can_hide),
                    Close::Quit,
                    "close_to_tray {close_to_tray}, can_hide {can_hide}"
                );
            }
        }
    }
}
