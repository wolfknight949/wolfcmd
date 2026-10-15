//! `wcmd-term`: the terminal's VT state, owned by Rust.
//!
//! Every byte the shell writes is parsed here (`alacritty_terminal`), so the core always
//! knows the screen contents. That makes scrollback snapshots ([`snapshot`]) and
//! reattach ([`Terminal::replay`]) possible. xterm.js renders the same byte stream in the UI.

mod cwd;
mod replay;
pub mod snapshot;
mod tail;
mod terminal;

pub use terminal::{Terminal, TerminalSize};
