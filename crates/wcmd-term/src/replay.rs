//! N-02: the replay. Everything a fresh terminal emulator (xterm.js in a reloaded page) needs to
//! show this session exactly as it is: the scrollback and the screen (text and SGR, wrapped rows
//! joined so they still reflow), the alternate screen of a full-screen program above the main
//! one, the cursor and its pen, the input modes programs switch on (cursor keys, bracketed
//! paste, mouse and focus reporting) and the window title.
//!
//! Unlike a snapshot (`snapshot.rs`) it is not dim and it does change modes: it is written into
//! an emulator that takes over the running session, never shown above a new one. Pure apart from
//! the alternate-screen swap (see [`replay`]); never log the result (terminal content).

use std::fmt::Write as _;

use alacritty_terminal::Term;
use alacritty_terminal::event::EventListener;
use alacritty_terminal::grid::{Dimensions as _, Grid};
use alacritty_terminal::index::Line;
use alacritty_terminal::term::TermMode;
use alacritty_terminal::term::cell::Cell;

use crate::snapshot::{Style, content_end, encode_cells, is_wrapped};

/// At most this many bytes of scrollback; the oldest rows go first (the screen always stays).
pub(crate) const MAX_REPLAY_BYTES: usize = 8 * 1024 * 1024;

/// The modes a program sets that change what the keyboard and mouse send, as `CSI ? n h`.
const PRIVATE_MODES: [(TermMode, u16); 8] = [
    (TermMode::APP_CURSOR, 1),
    (TermMode::MOUSE_REPORT_CLICK, 1000),
    (TermMode::MOUSE_DRAG, 1002),
    (TermMode::MOUSE_MOTION, 1003),
    (TermMode::FOCUS_IN_OUT, 1004),
    (TermMode::UTF8_MOUSE, 1005),
    (TermMode::SGR_MOUSE, 1006),
    (TermMode::BRACKETED_PASTE, 2004),
];

/// The replay of `term` within `max_bytes` of scrollback. On the alternate screen the primary
/// grid is read by swapping the screens and back; the alternate grid (which the swap back
/// clears) is put back as it was, so the state is unchanged afterwards.
pub(crate) fn replay<T: EventListener>(
    term: &mut Term<T>,
    title: Option<&str>,
    max_bytes: usize,
) -> Vec<u8> {
    let mut out = String::from("\x1b[0m");
    if term.mode().contains(TermMode::ALT_SCREEN) {
        let alternate = term.grid().clone();
        term.swap_alt();
        write_primary(term.grid(), max_bytes, &mut out);
        term.swap_alt();
        *term.grid_mut() = alternate;
        out.push_str("\x1b[?1049h");
        write_alternate(term.grid(), &mut out);
    } else {
        write_primary(term.grid(), max_bytes, &mut out);
    }
    write_cursor_and_modes(term, &mut out);
    if let Some(title) = title {
        let title: String = title.chars().filter(|c| !c.is_control()).collect();
        let _ = write!(out, "\x1b]0;{title}\x07");
    }
    out.into_bytes()
}

/// The primary grid: scrollback and every screen row (the empty ones too, so the cursor
/// position below is relative to the same screen), one `\r\n` between rows that did not wrap.
fn write_primary(grid: &Grid<Cell>, max_bytes: usize, out: &mut String) {
    let cols = grid.columns();
    let history = i32::try_from(grid.history_size()).unwrap_or(i32::MAX);
    let rows = i32::try_from(grid.screen_lines()).unwrap_or(i32::MAX);
    let last = rows - 1;
    let mut lines = Vec::new();
    let mut after_wrap = false;
    for row in -history..rows {
        let cells = &grid[Line(row)];
        let wrapped = row != last && is_wrapped(cells, cols);
        let mut end = if wrapped {
            cols
        } else {
            content_end(cells, cols)
        };
        // A row that continues a wrapped one is written even when blank: its first cell is what
        // moves the cursor down (a line feed in the wrap's pending state would skip a row).
        if after_wrap {
            end = end.max(1);
        }
        let mut line = encode_cells(cells, end, false);
        if !wrapped && row != last {
            line.push_str("\r\n");
        }
        after_wrap = wrapped;
        lines.push(line);
    }
    // The screen always; the newest scrollback rows that fit in the budget.
    let screen = usize::try_from(rows).unwrap_or(0).min(lines.len());
    let mut keep = lines.len() - screen;
    let mut total: usize = lines[keep..].iter().map(String::len).sum();
    while keep > 0 && total + lines[keep - 1].len() <= max_bytes {
        keep -= 1;
        total += lines[keep].len();
    }
    for line in &lines[keep..] {
        out.push_str(line);
    }
}

/// The alternate screen, row by row at absolute positions (never scrolls).
fn write_alternate(grid: &Grid<Cell>, out: &mut String) {
    let cols = grid.columns();
    for (index, row) in (0..i32::try_from(grid.screen_lines()).unwrap_or(0)).enumerate() {
        let cells = &grid[Line(row)];
        let end = content_end(cells, cols);
        if end > 0 {
            let _ = write!(out, "\x1b[{};1H", index + 1);
            out.push_str(&encode_cells(cells, end, false));
        }
    }
}

fn write_cursor_and_modes<T>(term: &Term<T>, out: &mut String) {
    let cursor = &term.grid().cursor;
    let line = usize::try_from(cursor.point.line.0).unwrap_or(0);
    let _ = write!(out, "\x1b[{};{}H", line + 1, cursor.point.column.0 + 1);
    let pen = Style::of(&cursor.template, false);
    if pen != Style::PLAIN {
        pen.write_sgr(out);
    }
    let mode = *term.mode();
    if !mode.contains(TermMode::SHOW_CURSOR) {
        out.push_str("\x1b[?25l");
    }
    if !mode.contains(TermMode::LINE_WRAP) {
        out.push_str("\x1b[?7l");
    }
    if mode.contains(TermMode::INSERT) {
        out.push_str("\x1b[4h");
    }
    if mode.contains(TermMode::APP_KEYPAD) {
        out.push_str("\x1b=");
    }
    for (flag, number) in PRIVATE_MODES {
        if mode.contains(flag) {
            let _ = write!(out, "\x1b[?{number}h");
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::{Terminal, TerminalSize};

    fn term(cols: u16, rows: u16) -> Terminal {
        Terminal::new(TerminalSize { cols, rows }, 10_000)
    }

    /// Feeds `a`'s replay into a fresh terminal of the same size.
    fn replayed(a: &mut Terminal) -> Terminal {
        let size = a.size();
        let mut b = term(size.cols, size.rows);
        b.advance(&a.replay());
        b
    }

    #[test]
    fn n02_replay_reproduces_screen_scrollback_and_cursor() {
        let mut a = term(20, 5);
        for n in 1..=30 {
            a.advance(format!("\x1b[3{}mline {n}\x1b[0m\r\n", n % 8).as_bytes());
        }
        a.advance(b"PS> half\x1b[1;5H\x1b[1;33m");
        let mut b = replayed(&mut a);
        assert_eq!(b.screen_text(), a.screen_text());
        assert_eq!(b.recent_text(100), a.recent_text(100));
        assert_eq!(b.cursor(), a.cursor());
        // Same colors everywhere and the same pen: typing continues in bold yellow.
        assert_eq!(b.snapshot(false), a.snapshot(false));
        a.advance(b"X");
        b.advance(b"X");
        assert_eq!(b.snapshot(false), a.snapshot(false));
    }

    #[test]
    fn n02_replay_keeps_wrapped_rows_and_blank_continuations() {
        let mut a = term(10, 6);
        // A row that wraps onto a blank continuation, then more output.
        a.advance(b"0123456789          \r\nnext\r\n0123456789abc");
        let b = replayed(&mut a);
        assert_eq!(b.screen_text(), a.screen_text());
        assert_eq!(b.cursor(), a.cursor());
        assert_eq!(b.snapshot(false), a.snapshot(false));
    }

    #[test]
    fn n02_replay_restores_modes_and_title() {
        let mut a = term(20, 4);
        a.advance(b"\x1b]0;agent at work\x07\x1b[?2004h\x1b[?1h\x1b[?1002h\x1b[?1006h\x1b[?1004h\x1b[?25l");
        let replay = String::from_utf8(a.replay()).expect("utf-8");
        for mode in ["?2004h", "?1h", "?1002h", "?1006h", "?1004h", "?25l"] {
            assert!(replay.contains(mode), "{mode}");
        }
        assert!(replay.contains("\x1b]0;agent at work\x07"));
        let b = replayed(&mut a);
        assert!(b.bracketed_paste());
        assert_eq!(b.title().as_deref(), Some("agent at work"));
    }

    #[test]
    fn n02_replay_of_a_full_screen_program_keeps_both_screens() {
        let mut a = term(20, 4);
        a.advance(b"shell 1\r\nshell 2\r\n\x1b[?1049h\x1b[2;3Hvim here\x1b[4;1H~");
        let before = a.screen_text();
        let cursor = a.cursor();
        let mut b = replayed(&mut a);
        // Replaying left the session's own state alone.
        assert_eq!(a.screen_text(), before);
        assert_eq!(a.cursor(), cursor);
        assert_eq!(b.screen_text(), before);
        assert_eq!(b.cursor(), cursor);
        // When the program exits, the shell's screen is back in both.
        a.advance(b"\x1b[?1049l");
        b.advance(b"\x1b[?1049l");
        assert_eq!(b.screen_text(), a.screen_text());
        assert!(a.screen_text().iter().any(|l| l == "shell 2"));
    }

    /// A view that takes over between two reads that split a sequence reads it whole.
    #[test]
    fn n02_replay_taken_inside_a_sequence_continues_it() {
        let mut a = term(20, 4);
        a.advance(b"one \x1b[3");
        let mut b = replayed(&mut a);
        for t in [&mut a, &mut b] {
            t.advance(b"1mred\x1b[0m two \xe2\x9c");
        }
        let mut c = replayed(&mut a);
        for t in [&mut a, &mut b, &mut c] {
            t.advance(b"\x93");
        }
        assert_eq!(a.screen_text()[0], "one red two ✓");
        assert_eq!(b.snapshot(false), a.snapshot(false));
        assert_eq!(c.snapshot(false), a.snapshot(false));
    }

    #[test]
    fn n02_replay_drops_the_oldest_scrollback_beyond_its_budget() {
        let mut a = term(10, 3);
        for n in 1..=100 {
            a.advance(format!("{n}\r\n").as_bytes());
        }
        let size = a.size();
        let mut b = term(size.cols, size.rows);
        b.advance(&super::replay(&mut a.term, None, 20));
        assert_eq!(b.screen_text(), a.screen_text());
        let kept = b.recent_text(1000);
        assert!(kept.len() < 20, "{kept:?}");
        assert_eq!(kept.last(), a.recent_text(1).last());
    }
}
