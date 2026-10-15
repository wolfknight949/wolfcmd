//! `pty` domain: terminal sessions (N-02). Handlers are async so they run off the main
//! thread; none of them blocks (input is queued, opening runs on the blocking pool).

use std::sync::Arc;

use specta::datatype::DataType;
use specta::{Type, Types};
use tauri::State;
use tauri::ipc::{Channel, InvokeResponseBody, IpcResponse};

use crate::error::{ErrorKind, WcmdError};
use crate::session::{
    LocalSessionHost, ProfileInfo, PtyAckArgs, PtyDetachArgs, PtyOpenArgs, PtyOpenResult,
    PtyResizeArgs, PtyWriteArgs, SessionEvent,
};

pub(crate) type Host = Arc<LocalSessionHost>;

/// One message on a terminal's stream. The TS side receives `unknown` and narrows it:
/// an `ArrayBuffer` is output (raw bytes, no JSON encoding), `{ cwd }` is a folder change,
/// `{ agentExited: true }` says the panel's agent ended (N-06),
/// and `{ exited: { code } }` is the final message.
pub(crate) struct PtyStreamMessage(SessionEvent);

impl IpcResponse for PtyStreamMessage {
    fn body(self) -> tauri::Result<InvokeResponseBody> {
        Ok(match self.0 {
            SessionEvent::Output(bytes) => InvokeResponseBody::Raw(bytes),
            SessionEvent::Cwd(cwd) => {
                InvokeResponseBody::Json(serde_json::json!({ "cwd": cwd }).to_string())
            }
            SessionEvent::AgentExited => {
                InvokeResponseBody::Json(serde_json::json!({ "agentExited": true }).to_string())
            }
            SessionEvent::Exited { code } => InvokeResponseBody::Json(
                serde_json::json!({ "exited": { "code": code } }).to_string(),
            ),
        })
    }
}

impl Type for PtyStreamMessage {
    fn definition(types: &mut Types) -> DataType {
        specta_typescript::Unknown::<()>::definition(types)
    }
}

/// A terminal view opens: it attaches to its panel's running session (the stream starts with
/// the replay of its screen and scrollback) or starts a shell (the default one unless the args
/// name a profile). Output and the exit arrive on `stream`, in order.
#[tauri::command]
#[specta::specta]
pub(crate) async fn pty_open(
    host: State<'_, Host>,
    args: PtyOpenArgs,
    stream: Channel<PtyStreamMessage>,
) -> Result<PtyOpenResult, WcmdError> {
    let host = Arc::clone(&host);
    let sink = Box::new(move |event| stream.send(PtyStreamMessage(event)).is_ok());
    tauri::async_runtime::spawn_blocking(move || host.open(args, sink))
        .await
        .map_err(|e| WcmdError::internal("terminal open task failed", &e))?
}

/// The shells this machine has, default first.
#[tauri::command]
#[specta::specta]
pub(crate) async fn pty_list_profiles(
    host: State<'_, Host>,
) -> Result<Vec<ProfileInfo>, WcmdError> {
    Ok(host.profiles())
}

/// Keystrokes and pastes, numbered per view so they reach the shell in order, once. Queued
/// for the session's input thread; never blocks.
#[tauri::command]
#[specta::specta]
pub(crate) async fn pty_write(host: State<'_, Host>, args: PtyWriteArgs) -> Result<(), WcmdError> {
    host.write(args)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn pty_resize(
    host: State<'_, Host>,
    args: PtyResizeArgs,
) -> Result<(), WcmdError> {
    if args.size.cols == 0 || args.size.rows == 0 {
        return Err(WcmdError::new(
            ErrorKind::InvalidArgument,
            "terminal size must be at least 1×1",
        ));
    }
    host.resize(args)
}

/// Output the UI has processed. Sent in large steps, so interactive use never acks.
#[tauri::command]
#[specta::specta]
pub(crate) async fn pty_ack(host: State<'_, Host>, args: PtyAckArgs) -> Result<(), WcmdError> {
    host.ack(args)
}

/// The view unmounted. The session keeps running: it ends when its panel leaves the
/// workspace document (`state_save`), its shell exits, or the app quits.
#[tauri::command]
#[specta::specta]
pub(crate) async fn pty_detach(
    host: State<'_, Host>,
    args: PtyDetachArgs,
) -> Result<(), WcmdError> {
    host.detach(args);
    Ok(())
}
