//! `wcmd-state`: the workspace document (N-03, N-05). The UI owns the live copy and edits it;
//! the core loads it at start (migrating an older format, `migrate.rs`), checks it
//! ([`Document::normalized`]) and saves every change the UI sends, crash-safe ([`StateFile`]),
//! keeping backups of the last good file. These types are the contract: the UI's are generated.

mod backup;
mod document;
mod file;
mod migrate;
mod window;

pub use document::{
    AgentRef, CURRENT_VERSION, Direction, Document, Layout, MIN_RATIO, Panel, PanelContent,
    TERMINAL_KIND, Tab, TerminalContent, TerminalKind, UnknownContent, Workspace,
};
pub use file::{Loaded, ReadOnly, Source, StateFile};
pub use window::{MonitorRef, WindowBounds, WindowFile};
