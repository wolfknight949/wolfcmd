//! `state` domain (N-05): the workspace document. The UI loads it once at start and sends
//! every change; the core saves it crash-safe (`crate::state`) and reports saving trouble
//! (`StateHealth`, also the `state-health` event).

use std::collections::HashSet;
use std::sync::Arc;

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, State};
use tauri_specta::Event as _;
use wcmd_state::Document;

use crate::error::WcmdError;
use crate::ipc::pty::Host;
use crate::session::LocalSessionHost;
/// The `state-health` event, registered with the others in `ipc/mod.rs`.
pub(crate) use crate::state::StateHealth;
use crate::state::StateService;

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LoadedState {
    pub(crate) document: Document,
    /// Changes are shown but not saved (`health.readOnly` says why).
    pub(crate) read_only: bool,
    /// What the user should know about saving now; later changes come as `state-health`.
    pub(crate) health: StateHealth,
}

/// The document at start. Also connects the `state-health` event to this page.
#[tauri::command]
#[specta::specta]
pub(crate) async fn state_load(
    app: AppHandle,
    state: State<'_, Arc<StateService>>,
) -> Result<LoadedState, WcmdError> {
    state.on_health(move |health| {
        if let Err(error) = health.clone().emit(&app) {
            tracing::warn!(%error, "N-05: could not tell the UI about saving");
        }
    });
    Ok(LoadedState {
        document: state.document(),
        read_only: state.read_only(),
        health: state.health(),
    })
}

/// Every change the UI makes. Returns at once; the writer thread saves it. N-02: a terminal panel
/// that left the document was closed, so its session ends (a page reload never ends one).
/// `seq` numbers the page's saves from 1: invokes may run in any order, and an older document
/// must never land over a newer one (nor end the session of a panel the newer one added).
#[tauri::command]
#[specta::specta]
pub(crate) async fn state_save(
    state: State<'_, Arc<StateService>>,
    host: State<'_, Host>,
    seq: u32,
    document: Document,
) -> Result<(), WcmdError> {
    save_and_end_closed(&state, &host, seq, document);
    Ok(())
}

/// Saves `document` (unless a newer one, by `seq`, was saved already) and ends the sessions of
/// the terminal panels it no longer has (N-03: only terminals have sessions). Saves are
/// serialized here, so the panels compared are those of the document saved just before.
fn save_and_end_closed(
    state: &StateService,
    host: &LocalSessionHost,
    seq: u32,
    document: Document,
) {
    let mut last = state.save_order();
    if seq <= *last {
        tracing::debug!(
            seq,
            last = *last,
            "N-05: an older document came late; dropped"
        );
        return;
    }
    *last = seq;
    let before = state.terminal_ids();
    state.save(document);
    let after = state.terminal_ids();
    let closed: HashSet<String> = before.difference(&after).cloned().collect();
    host.kill_panels(&closed);
}

#[cfg(all(test, windows))]
mod tests {
    use std::sync::mpsc;
    use std::time::Duration;

    use wcmd_pty::{PtySize, ShellIntegration};
    use wcmd_state::{Layout, Panel, Tab, TerminalContent, Workspace};

    use super::*;
    use crate::session::{PtyOpenArgs, SessionEvent};

    fn document(panels: &[&str]) -> Document {
        let tab = |panel: &&str| Tab {
            id: format!("t-{panel}"),
            name: String::new(),
            layout: Some(Layout::Panel(Panel::terminal(
                *panel,
                TerminalContent::default(),
            ))),
            focused: Some((*panel).to_owned()),
            maximized: None,
        };
        Document {
            version: wcmd_state::CURRENT_VERSION,
            workspaces: vec![Workspace {
                id: "w1".into(),
                name: String::new(),
                folder: None,
                tabs: panels.iter().map(tab).collect(),
                active_tab: None,
                main: None,
            }],
            active: Some("w1".into()),
        }
    }

    /// N-02: the session of a panel the user closed ends; the other one keeps running.
    #[test]
    fn n02_a_panel_closed_in_the_document_ends_its_session() {
        let dir = std::env::temp_dir().join(format!("wcmd-ipc-close-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let state = StateService::open(&dir);
        let host = LocalSessionHost::new(ShellIntegration::disabled());
        save_and_end_closed(&state, &host, 1, document(&["kept", "closed"]));
        let open = |panel: &str| {
            let (tx, rx) = mpsc::channel();
            let args = PtyOpenArgs {
                request_id: panel.to_owned(),
                size: PtySize { cols: 80, rows: 24 },
                cwd: None,
                profile_id: Some("cmd".to_owned()),
                panel_id: Some(panel.to_owned()),
            };
            host.open(args, Box::new(move |e| tx.send(e).is_ok()))
                .expect("open");
            rx
        };
        let kept = open("kept");
        let closed = open("closed");

        save_and_end_closed(&state, &host, 2, document(&["kept"]));
        let ended = closed
            .iter()
            .find(|e| matches!(e, SessionEvent::Exited { .. }));
        assert!(ended.is_some());
        std::thread::sleep(Duration::from_millis(200));
        assert!(
            !kept
                .try_iter()
                .any(|e| matches!(e, SessionEvent::Exited { .. }))
        );
        host.kill_all();
        state.flush();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// N-05: invokes may run in any order; an older document that comes late is dropped, so it
    /// neither lands over the newer one nor ends the session of the panel the newer one added.
    /// A reloaded page numbers its saves from 1 again.
    #[test]
    fn n05_an_older_document_that_comes_late_is_dropped() {
        let dir = std::env::temp_dir().join(format!("wcmd-ipc-order-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let state = StateService::open(&dir);
        let host = LocalSessionHost::new(ShellIntegration::disabled());
        let panels = |state: &StateService| {
            let mut ids: Vec<String> = state.terminal_ids().into_iter().collect();
            ids.sort();
            ids
        };
        save_and_end_closed(&state, &host, 1, document(&["a"]));
        save_and_end_closed(&state, &host, 3, document(&["a", "split"]));
        save_and_end_closed(&state, &host, 2, document(&["a"]));
        assert_eq!(panels(&state), ["a", "split"]);

        state.page_loading();
        save_and_end_closed(&state, &host, 1, document(&["a"]));
        assert_eq!(panels(&state), ["a"]);
        state.flush();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
