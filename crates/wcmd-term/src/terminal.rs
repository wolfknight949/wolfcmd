use std::sync::{Arc, Mutex, PoisonError};

use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::Dimensions as _;
use alacritty_terminal::term::test::TermSize;
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::vte::ansi::{Processor, StdSyncHandler};

use crate::cwd::CwdScanner;
use crate::replay;
use crate::snapshot::{self, SnapshotOptions};
use crate::tail::Tail;

/// Keeps the window title (for the replay and N-06 agent activity) and drops every other event:
/// in particular `PtyWrite`, the replies to terminal queries, which xterm.js answers (mirror
/// only).
#[derive(Debug, Clone, Default)]
pub(crate) struct Listener {
    title: Arc<Mutex<TitleSlot>>,
}

/// The title and whether it changed since [`Terminal::take_title`] last looked.
#[derive(Debug, Default)]
struct TitleSlot {
    title: Option<String>,
    changed: bool,
}

impl Listener {
    fn title(&self) -> Option<String> {
        self.title
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .title
            .clone()
    }
}

impl EventListener for Listener {
    fn send_event(&self, event: Event) {
        let title = match event {
            Event::Title(title) => Some(title),
            Event::ResetTitle => None,
            _ => return,
        };
        let mut slot = self.title.lock().unwrap_or_else(PoisonError::into_inner);
        if slot.title != title {
            slot.title = title;
            slot.changed = true;
        }
    }
}

/// Screen size in character cells.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalSize {
    pub cols: u16,
    pub rows: u16,
}

impl TerminalSize {
    fn to_term_size(self) -> TermSize {
        // At least 1×1: a zero-sized grid is invalid in alacritty_terminal.
        TermSize::new(usize::from(self.cols.max(1)), usize::from(self.rows.max(1)))
    }
}

/// The VT state of one terminal session.
///
/// Invariant: this is a *mirror*. xterm.js in the UI answers terminal queries
/// (DSR, DA…), so this type never writes back to the PTY; that's why it uses
/// `Listener` (it keeps only the title). If a separate session host ever owns sessions without a
/// UI, replies move here.
pub struct Terminal {
    pub(crate) term: Term<Listener>,
    listener: Listener,
    parser: Processor<StdSyncHandler>,
    cwd: CwdScanner,
    /// The unfinished sequence the stream ends inside of, for the replay.
    tail: Tail,
    /// Bytes were fed since the last `take_changed`.
    changed: bool,
}

impl std::fmt::Debug for Terminal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Terminal")
            .field("size", &self.size())
            .finish_non_exhaustive()
    }
}

impl Terminal {
    pub fn new(size: TerminalSize, scrollback_lines: usize) -> Self {
        let config = Config {
            scrolling_history: scrollback_lines,
            ..Config::default()
        };
        let listener = Listener::default();
        Self {
            term: Term::new(config, &size.to_term_size(), listener.clone()),
            listener,
            parser: Processor::new(),
            cwd: CwdScanner::default(),
            tail: Tail::default(),
            changed: false,
        }
    }

    /// Feeds raw PTY output through the VT parser.
    pub fn advance(&mut self, bytes: &[u8]) {
        self.parser.advance(&mut self.term, bytes);
        self.cwd.feed(bytes);
        self.tail.feed(bytes);
        self.changed = true;
    }

    /// The folder the shell reported (OSC 7 or OSC 9;9) since the last call.
    pub fn take_cwd(&mut self) -> Option<String> {
        self.cwd.take()
    }

    /// N-06: the window title (OSC 0 / 2) when it changed since the last call; empty when the
    /// program reset it. Agents show their state there (`wcmd-app`'s `session/activity.rs`).
    pub fn take_title(&mut self) -> Option<String> {
        let mut slot = self
            .listener
            .title
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if !std::mem::take(&mut slot.changed) {
            return None;
        }
        Some(slot.title.clone().unwrap_or_default())
    }

    /// N-06: how many prompts the shell started (`OSC 133 ; A` from shell integration). A
    /// command typed at prompt `n` has ended once this is past `n`.
    pub fn prompts(&self) -> u64 {
        self.cwd.prompts()
    }

    /// Whether the program asked for bracketed paste (`CSI ? 2004 h`), so pasted text
    /// arrives as one paste instead of typed lines. Agents' input boxes do; a bare shell
    /// prompt may not.
    #[cfg(test)]
    pub fn bracketed_paste(&self) -> bool {
        self.term.mode().contains(TermMode::BRACKETED_PASTE)
    }

    /// The scrollback and screen as VT bytes (text and SGR attributes; at most
    /// [`snapshot::MAX_LINES`] rows and [`snapshot::MAX_BYTES`]), every cell dim when `dim`.
    /// `None` while a full-screen program uses the alternate screen: that screen means nothing
    /// once the program is gone, so the last snapshot of the main screen is kept instead.
    /// Never log the result (it is terminal content).
    pub fn snapshot(&self, dim: bool) -> Option<Vec<u8>> {
        self.snapshot_with(SnapshotOptions {
            dim,
            ..SnapshotOptions::default()
        })
    }

    /// Whether output was fed since the last call (a new snapshot is worth taking).
    pub fn take_changed(&mut self) -> bool {
        std::mem::take(&mut self.changed)
    }

    /// [`Self::snapshot`] with other caps.
    pub(crate) fn snapshot_with(&self, options: SnapshotOptions) -> Option<Vec<u8>> {
        if self.term.mode().contains(TermMode::ALT_SCREEN) {
            return None;
        }
        Some(snapshot::serialize(&self.term, options))
    }

    /// N-02: what a fresh emulator needs to take over this session exactly (see
    /// [`crate::replay`]): scrollback (the newest [`replay::MAX_REPLAY_BYTES`]) and screen, the
    /// alternate screen, cursor, pen, input modes and title, then the start of an unfinished
    /// sequence the output ends inside of (`src/tail.rs`). Not dim. `&mut` only because the
    /// alternate screen is read by swapping screens and back; the state is unchanged. Never
    /// log the result (it is terminal content).
    pub fn replay(&mut self) -> Vec<u8> {
        let title = self.listener.title();
        let mut replay = replay::replay(&mut self.term, title.as_deref(), replay::MAX_REPLAY_BYTES);
        // The output so far may end inside a sequence: its start, so the rest reads right.
        replay.extend_from_slice(self.tail.bytes());
        replay
    }

    /// The cursor as (row on screen, column), both from 0.
    #[cfg(test)]
    pub(crate) fn cursor(&self) -> (i32, usize) {
        let point = self.term.grid().cursor.point;
        (point.line.0, point.column.0)
    }

    /// The window title the program set last.
    #[cfg(test)]
    pub(crate) fn title(&self) -> Option<String> {
        self.listener.title()
    }

    pub fn resize(&mut self, size: TerminalSize) {
        self.term.resize(size.to_term_size());
    }

    pub fn size(&self) -> TerminalSize {
        let clamp = |n: usize| u16::try_from(n).unwrap_or(u16::MAX);
        TerminalSize {
            cols: clamp(self.term.columns()),
            rows: clamp(self.term.screen_lines()),
        }
    }

    /// The visible screen as text, one string per row, trailing spaces trimmed.
    /// For tests (`test-util`); never log the result (it is terminal content).
    #[cfg(any(test, feature = "test-util"))]
    pub fn screen_text(&self) -> Vec<String> {
        let rows = i32::try_from(self.term.screen_lines()).unwrap_or(i32::MAX);
        (0..rows).map(|row| self.row_text(row)).collect()
    }

    /// The last `count` lines of scrollback and screen as text, oldest first, trailing
    /// spaces and the empty rows below the last output trimmed. For tests (`test-util`); never
    /// log the result (it is terminal content).
    #[cfg(any(test, feature = "test-util"))]
    pub fn recent_text(&self, count: usize) -> Vec<String> {
        let history = i32::try_from(self.term.grid().history_size()).unwrap_or(i32::MAX);
        let rows = i32::try_from(self.term.screen_lines()).unwrap_or(i32::MAX);
        // Enough rows for `count` lines even when the bottom of the screen is empty.
        let window = i32::try_from(count)
            .unwrap_or(i32::MAX)
            .saturating_add(rows);
        let first = rows.saturating_sub(window).max(-history);
        let mut lines: Vec<String> = (first..rows).map(|row| self.row_text(row)).collect();
        while lines.last().is_some_and(String::is_empty) {
            lines.pop();
        }
        let start = lines.len().saturating_sub(count);
        lines.split_off(start)
    }

    /// One grid row (negative: scrollback) as text, trailing spaces trimmed.
    #[cfg(any(test, feature = "test-util"))]
    fn row_text(&self, row: i32) -> String {
        use alacritty_terminal::index::{Column, Line};
        let line = &self.term.grid()[Line(row)];
        let text: String = (0..self.term.columns())
            .map(|col| line[Column(col)].c)
            .collect();
        text.trim_end().to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn term(cols: u16, rows: u16) -> Terminal {
        Terminal::new(TerminalSize { cols, rows }, 1000)
    }

    #[test]
    fn tracks_bracketed_paste_mode() {
        let mut t = term(20, 3);
        assert!(!t.bracketed_paste());
        t.advance(b"\x1b[?2004h");
        assert!(t.bracketed_paste());
        t.advance(b"\x1b[?2004l");
        assert!(!t.bracketed_paste());
    }

    #[test]
    fn t03_plain_text_lands_on_screen() {
        let mut t = term(20, 3);
        t.advance(b"hello\r\nworld");
        assert_eq!(t.screen_text(), ["hello", "world", ""]);
    }

    #[test]
    fn t03_escape_sequences_are_interpreted_not_printed() {
        let mut t = term(20, 2);
        // Red text, then a cursor move to row 2 col 3 (1-based).
        t.advance(b"\x1b[31mred\x1b[0m\x1b[2;3Hx");
        assert_eq!(t.screen_text(), ["red", "  x"]);
    }

    #[test]
    fn t03_utf8_split_across_chunks_is_reassembled() {
        let mut t = term(10, 1);
        let bytes = "é✓".as_bytes();
        for byte in bytes {
            t.advance(std::slice::from_ref(byte));
        }
        assert_eq!(t.screen_text(), ["é✓"]);
    }

    #[test]
    fn t03_resize_changes_the_grid() {
        let mut t = term(80, 24);
        t.resize(TerminalSize {
            cols: 100,
            rows: 30,
        });
        assert_eq!(
            t.size(),
            TerminalSize {
                cols: 100,
                rows: 30
            }
        );
    }

    #[test]
    fn recent_text_reaches_into_scrollback() {
        let mut t = term(20, 3);
        for n in 1..=6 {
            t.advance(format!("line {n}\r\n").as_bytes());
        }
        // Six lines, then the cursor on an empty last row; three rows on screen.
        assert_eq!(t.recent_text(2), ["line 5", "line 6"]);
        assert_eq!(
            t.recent_text(100),
            ["line 1", "line 2", "line 3", "line 4", "line 5", "line 6"]
        );
        assert_eq!(t.recent_text(0), Vec::<String>::new());
        assert_eq!(term(10, 4).recent_text(10), Vec::<String>::new());
    }

    #[test]
    fn t03_zero_size_is_clamped() {
        let t = term(0, 0);
        assert_eq!(t.size(), TerminalSize { cols: 1, rows: 1 });
    }

    #[test]
    fn n06_a_changed_title_is_taken_once() {
        let mut t = term(20, 3);
        assert_eq!(t.take_title(), None);
        // Split across chunks, like a PTY read.
        t.advance("\x1b]0;\u{25d0} Fix".as_bytes());
        assert_eq!(t.take_title(), None);
        t.advance(b" the bug\x07");
        assert_eq!(t.take_title().as_deref(), Some("\u{25d0} Fix the bug"));
        assert_eq!(t.take_title(), None);
        // The same title again is no change; OSC 2 and an empty title are.
        t.advance("\x1b]0;\u{25d0} Fix the bug\x07".as_bytes());
        assert_eq!(t.take_title(), None);
        t.advance("\x1b]2;\u{2733} Fix the bug\x1b\\".as_bytes());
        assert_eq!(t.take_title().as_deref(), Some("\u{2733} Fix the bug"));
        t.advance(b"\x1b]0;\x07");
        assert!(t.take_title().is_some());
    }
}
