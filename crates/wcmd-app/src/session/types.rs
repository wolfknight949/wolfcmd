//! IPC argument and result types for the `pty` domain.

use serde::{Deserialize, Serialize};
use specta::Type;
use wcmd_pty::PtySize;

/// Identifies a terminal session for its whole life. Never reused within a run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(transparent)]
pub(crate) struct SessionId(pub(crate) u32);

/// N-02: one view's connection to a session. A session has at most one at a time; a new one
/// (a reloaded page, a remounted panel) replaces the last, and calls that name an older one
/// change nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(transparent)]
pub(crate) struct AttachmentId(pub(crate) u32);

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PtyOpenArgs {
    /// Client-generated and unique per call. Repeating it returns the same result, so an IPC
    /// call that is delivered twice (Tauri retries over its fallback transport) can't start a
    /// second shell or attach twice.
    pub(crate) request_id: String,
    /// The view's size, measured before opening so the first prompt (or the replay) fits.
    pub(crate) size: PtySize,
    /// Working directory of a new shell; the profile's default when absent.
    pub(crate) cwd: Option<String>,
    /// Which shell for a new session; the default profile when absent.
    pub(crate) profile_id: Option<String>,
    /// The panel this terminal belongs to: its running session is attached to instead of
    /// starting another, and its scrollback is saved under it (N-05).
    pub(crate) panel_id: Option<String>,
}

/// A shell the user can open.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileInfo {
    pub(crate) id: String,
    pub(crate) name: String,
    /// A ui-kit glyph name.
    pub(crate) icon: String,
    pub(crate) is_default: bool,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
#[allow(clippy::struct_excessive_bools)] // independent facts the view reads once, not a state
pub(crate) struct PtyOpenResult {
    pub(crate) session_id: SessionId,
    /// Shown in the block header, e.g. "PowerShell".
    pub(crate) profile_name: String,
    /// N-06: the profile the shell really runs: the asked one, or the default when that one is
    /// gone. An agent's start line is quoted for this shell.
    pub(crate) profile_id: String,
    /// N-06: the shell was started with WolfCmd's shell integration, so it marks its prompts
    /// (OSC 133). Without it, the UI can only guess when the shell is ready.
    pub(crate) integrated: bool,
    /// N-06: the agent typed into this session (a write with `agent`) has ended: the shell is
    /// back at a prompt. Also sent on the stream as `{ agentExited: true }` when it happens.
    pub(crate) agent_exited: bool,
    /// N-06: the agent typed into this session is working now (`session/activity.rs`); later
    /// changes come as the `agent-activity` event.
    pub(crate) agent_working: bool,
    /// Names this view in `pty_write`, `pty_ack` and `pty_detach`.
    pub(crate) attachment: AttachmentId,
    /// The panel's session was already running: the stream starts with its replay (screen,
    /// scrollback, modes), and nothing must be typed into it (an agent is already there).
    pub(crate) attached: bool,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PtyWriteArgs {
    pub(crate) session_id: SessionId,
    pub(crate) attachment: AttachmentId,
    /// 1, 2, 3… per attachment. IPC calls can arrive out of order or twice; the core writes
    /// each sequence number once, in order (N-02).
    pub(crate) seq: u32,
    /// Input as typed or pasted; written to the shell as UTF-8.
    pub(crate) data: String,
    /// N-06: this is the line that starts the panel's agent (its id), typed at a prompt. The
    /// session watches whether the agent works (its `working_title`, else output activity) and
    /// reports `agent_exited` once the shell shows its next prompt.
    #[serde(default)]
    pub(crate) agent: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PtyResizeArgs {
    pub(crate) session_id: SessionId,
    pub(crate) size: PtySize,
}

/// Output the UI has finished processing (flow control, see `session/flow.rs`).
#[derive(Debug, Clone, Copy, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PtyAckArgs {
    pub(crate) session_id: SessionId,
    pub(crate) attachment: AttachmentId,
    pub(crate) bytes: u32,
}

/// The view is gone (its panel unmounted): the session keeps running.
#[derive(Debug, Clone, Copy, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PtyDetachArgs {
    pub(crate) session_id: SessionId,
    pub(crate) attachment: AttachmentId,
}
