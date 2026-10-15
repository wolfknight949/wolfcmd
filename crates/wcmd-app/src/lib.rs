//! `WolfCmd.exe`: the window (N-01), terminal sessions (N-02), the saved workspaces (N-05),
//! settings (N-07) and agent launch lines (N-06). The UI does everything else.

mod error;
mod git;
mod ipc;
mod logging;
mod open;
mod platform;
mod session;
mod startup;
mod state;
mod tray;
mod watchdog;
mod window_bounds;

use std::sync::Arc;
use std::time::Duration;

use tauri::webview::PageLoadEvent;
use tauri::{Manager as _, RunEvent};

pub use error::{ErrorKind, WcmdError};
pub use ipc::{BINDINGS_PATH, export_bindings, specta_builder};

use crate::ipc::pty::Host;
use crate::session::{LocalSessionHost, SnapshotStore};
use crate::state::StateService;
use crate::watchdog::Watchdog;
use crate::window_bounds::RestoreMaximized;

/// If the UI never reports its first frame (e.g. it failed to load), the window shows anyway.
const SHOW_FALLBACK: Duration = Duration::from_millis(1500);

/// Starts the app and blocks until it exits.
pub fn run() -> anyhow::Result<()> {
    startup::mark_started();
    logging::init();
    // The bundled Microsoft console host (`conpty.dll` + `OpenConsole.exe` next to the exe) is
    // about 3x faster than the one built into Windows; say which one this build uses.
    tracing::info!(console_host = ?wcmd_pty::console_host(), "N-02: ConPTY");
    let builder = specta_builder();
    // Debug runs keep the generated TS bindings current.
    #[cfg(debug_assertions)]
    if let Err(error) = export_bindings(&builder, std::path::Path::new(BINDINGS_PATH)) {
        tracing::warn!(%error, "could not export TS bindings");
    }
    // Discover shells in the background so the first terminal never waits for it.
    std::thread::spawn(wcmd_pty::installed_profiles);

    let dir = state::data_dir();
    if let Some(moved) = state::retire_old_data(&dir) {
        tracing::info!(to = %moved.display(), "a data folder of a different format was set aside");
    }
    // N-05: the saved session is loaded before the window exists, so it opens in place.
    let state = StateService::open(&dir);
    let agents = ipc::agents::registry(&dir);
    let settings = Arc::new(ipc::settings::SettingsService::in_dir(&dir));
    let host = session_host(&dir, &state, &agents, &settings);
    host.start_keeper();
    let watchdog = Arc::new(Watchdog::default());
    let exit_host = Arc::clone(&host);
    let page_host = Arc::clone(&host);
    let end_host = Arc::clone(&host);
    let activity_host = Arc::clone(&host);
    let page_watchdog = Arc::clone(&watchdog);
    let setup_watchdog = Arc::clone(&watchdog);
    let exit_state = Arc::clone(&state);
    let end_state = Arc::clone(&state);
    let setup_state = Arc::clone(&state);
    let page_state = Arc::clone(&state);

    let mut app = tauri::Builder::default();
    // One WolfCmd per data folder: a second launch brings the window forward (N-01: out of the
    // tray too, where it was). Debug builds and test runs (`WOLFCMD_DATA_DIR`) keep their own
    // data, so they never hand off.
    if !cfg!(debug_assertions) && std::env::var_os("WOLFCMD_DATA_DIR").is_none() {
        app = app.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::show_main(app);
        }));
    }
    let app = app
        .manage(host)
        .manage(state)
        .manage(settings)
        .manage(agents)
        .manage(RestoreMaximized::default())
        .manage(watchdog)
        .invoke_handler(builder.invoke_handler())
        // N-02: a reloaded page (hot reload in dev, the watchdog, a crashed renderer) has lost
        // its views, not its terminals: the shells keep running and the new page attaches.
        .on_page_load(move |webview, payload| {
            if webview.label() == "main" && payload.event() == PageLoadEvent::Started {
                page_host.detach_all();
                page_watchdog.page_loading();
                page_state.page_loading();
            }
        })
        .setup(move |app| {
            builder.mount_events(app);
            activity_host.on_activity(ipc::agents::activity_events(app.handle().clone()));
            let window = app
                .get_webview_window("main")
                .ok_or("the main window is missing from tauri.conf.json")?;
            // The first pixel is the theme's background (the setting; Auto: the system's), and
            // so is what a resize uncovers before the page paints (N-03).
            let setting = app.state::<Arc<ipc::settings::SettingsService>>().theme();
            let system = window.theme().unwrap_or(tauri::Theme::Dark);
            if let Err(error) =
                window.set_background_color(Some(startup::background_for(setting, system)))
            {
                tracing::warn!(%error, "could not set the window background");
            }
            if let Some(bounds) = setup_state.window()
                && let Err(error) = window_bounds::restore(&window, &bounds)
            {
                tracing::warn!(%error, "could not restore the window position");
            }
            window_bounds::track(&window, Arc::clone(&setup_state));
            platform::harden_webview(&window)?;
            if let Err(error) = platform::install_snap_overlay(&window) {
                tracing::warn!(%error, "Snap Layouts unavailable on the custom title bar");
            }
            if let Err(error) = platform::reload_on_process_failure(&window) {
                tracing::warn!(%error, "a crashed page will not reload by itself");
            }
            save_on_session_end(&window, end_state, end_host);
            // N-01: closing hides to the tray (the setting; Quit is the tray's menu and Ctrl+Q).
            let settings = Arc::clone(&*app.state::<Arc<ipc::settings::SettingsService>>());
            tray::install(&window, settings);
            setup_watchdog.start(window.clone());
            schedule_show_fallback(window);
            Ok(())
        })
        .build(tauri::generate_context!())?;
    app.run(move |app, event| {
        // N-01: macOS: a click on the Dock icon brings a hidden window back.
        if platform::is_reopen(&event) {
            tray::show_main(app);
        }
        if let RunEvent::ExitRequested { .. } = event {
            // However the app ends (the macOS menu's Quit too), a close now lets the window go.
            tray::quitting();
        }
        if let RunEvent::Exit = event {
            // N-05: nothing queued is lost, and each terminal keeps its latest output; then
            // every shell ends with the app, and no document the UI sends about those ends is
            // written (the agents they ran are resumed at the next start).
            exit_state.freeze();
            exit_state.flush();
            exit_host.flush_snapshots();
            exit_host.kill_all();
        }
    });
    Ok(())
}

/// The terminals' host: shell integration, scrollback kept under the data folder, the terminal
/// panels the document has (N-03: a session whose panel is no terminal there ends), (N-06) the
/// agents' working titles and (N-07) the default shell setting.
fn session_host(
    dir: &std::path::Path,
    state: &Arc<StateService>,
    agents: &Arc<wcmd_agents::AgentRegistry>,
    settings: &Arc<ipc::settings::SettingsService>,
) -> Host {
    let integration = wcmd_pty::ShellIntegration::install(&dir.join("shell-integration"));
    let panels = Arc::clone(state);
    let settings = Arc::clone(settings);
    Arc::new(
        LocalSessionHost::new(integration)
            .with_snapshots(SnapshotStore::for_app(dir, state))
            .with_panels(Box::new(move |panel: &str| panels.has_terminal(panel)))
            .with_title_patterns(ipc::agents::title_patterns(agents))
            .with_default_profile(Box::new(move || settings.default_profile())),
    )
}

/// N-05: Windows logoff, restart or update: save everything before it ends us, and write no
/// later document (Windows may end an agent before its shell, which must not be saved as the
/// agent's end: it is resumed at the next start) unless the end is cancelled.
fn save_on_session_end(window: &tauri::WebviewWindow, state: Arc<StateService>, host: Host) {
    let resume = Arc::clone(&state);
    if let Err(error) = platform::on_session_end(
        window,
        move || {
            state.freeze();
            state.flush();
            host.flush_snapshots();
        },
        move || resume.thaw(),
    ) {
        tracing::warn!(%error, "a Windows shutdown may lose the last changes");
    }
}

fn schedule_show_fallback(window: tauri::WebviewWindow) {
    std::thread::spawn(move || {
        std::thread::sleep(SHOW_FALLBACK);
        // Only when the UI never reported its first frame: a window it showed and the user then
        // hid to the tray stays hidden.
        if ipc::app::claim_first_reveal() && matches!(window.is_visible(), Ok(false)) {
            tracing::warn!("N-01: the UI did not report its first frame; showing the window");
            if let Err(error) = ipc::app::reveal(&window) {
                tracing::error!(%error, "could not show the window");
            }
        }
    });
}
