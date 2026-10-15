//! N-02: terminal sessions. `LocalSessionHost` runs each shell under ConPTY in-process, keeps
//! its VT state (for reattaching a view and the scrollback snapshot, N-05) and streams its
//! output to the attached view. A session outlives its view: a reloaded page attaches again.

mod activity;
mod batcher;
mod flow;
mod input_order;
mod local;
mod snapshot_store;
mod types;

pub(crate) use local::{ActivitySink, LocalSessionHost, TitlePatterns};
pub(crate) use snapshot_store::{SnapshotStore, WallClock};
pub(crate) use types::{
    ProfileInfo, PtyAckArgs, PtyDetachArgs, PtyOpenArgs, PtyOpenResult, PtyResizeArgs, PtyWriteArgs,
};

/// What a session reports to its view, in order: output chunks (with folder changes after the
/// chunk that reported them), then exactly one exit.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SessionEvent {
    Output(Vec<u8>),
    /// The shell reported a new folder (OSC 7 or OSC 9;9); the same folder again is not sent.
    Cwd(String),
    /// N-06: the agent started in this session ended (the shell's next prompt, OSC 133;A).
    AgentExited,
    Exited {
        code: Option<u32>,
    },
}

/// Receives a session's events. Returns `false` once nobody is listening any more.
pub(crate) type EventSink = Box<dyn FnMut(SessionEvent) -> bool + Send>;
