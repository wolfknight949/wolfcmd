//! Scrollback snapshots. The grid (scrollback + screen) as the VT bytes that draw it
//! again: the text plus SGR attributes, one row per line, wrapped rows joined so a restored
//! snapshot reflows at another width. Replaying a snapshot through a terminal (xterm.js in the
//! UI, [`Terminal::advance`](crate::Terminal::advance) in the core) shows the same text and
//! colors; nothing else is in it (no modes, cursor moves, titles or links).
//!
//! Pure: no I/O and no clock. Where snapshots are kept, when they are saved and the time on
//! the divider are `wcmd-app`'s (`session/snapshot_store.rs`). Never log a snapshot: it is
//! terminal content.

use std::fmt::Write as _;

use alacritty_terminal::Term;
use alacritty_terminal::grid::{Dimensions as _, Row};
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::vte::ansi::{Color, NamedColor};

/// At most this many rows are kept: the newest.
pub(crate) const MAX_LINES: usize = 2_000;
/// At most this many bytes of VT data; the oldest rows go first.
pub(crate) const MAX_BYTES: usize = 256 * 1024;

/// The first bytes of a snapshot file, then the save time (Unix seconds) and a newline. Another
/// version is not read (a cache: it is simply not restored).
const FILE_MAGIC: &[u8] = b"WCMDSB1 ";

/// How a snapshot is written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SnapshotOptions {
    pub(crate) max_lines: usize,
    pub(crate) max_bytes: usize,
    /// Every cell dim (SGR 2): how a restored snapshot looks above the new shell.
    pub(crate) dim: bool,
}

impl Default for SnapshotOptions {
    fn default() -> Self {
        Self {
            max_lines: MAX_LINES,
            max_bytes: MAX_BYTES,
            dim: true,
        }
    }
}

/// The attributes a cell is drawn with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Style {
    fg: Color,
    bg: Color,
    flags: Flags,
    underline: Option<Color>,
}

/// The flags that change how a cell looks (not wrapping or wide-character bookkeeping).
const STYLE_FLAGS: Flags = Flags::BOLD
    .union(Flags::DIM)
    .union(Flags::ITALIC)
    .union(Flags::ALL_UNDERLINES)
    .union(Flags::INVERSE)
    .union(Flags::HIDDEN)
    .union(Flags::STRIKEOUT);

impl Style {
    /// The terminal's default after `ESC[0m`.
    pub(crate) const PLAIN: Self = Self {
        fg: Color::Named(NamedColor::Foreground),
        bg: Color::Named(NamedColor::Background),
        flags: Flags::empty(),
        underline: None,
    };

    pub(crate) fn of(cell: &Cell, dim: bool) -> Self {
        let mut flags = cell.flags & STYLE_FLAGS;
        if dim {
            flags |= Flags::DIM;
        }
        Self {
            fg: cell.fg,
            bg: cell.bg,
            flags,
            underline: cell.underline_color(),
        }
    }

    /// `ESC[0;…m`: a full reset, then this style's attributes.
    pub(crate) fn write_sgr(&self, out: &mut String) {
        out.push_str("\x1b[0");
        let flags = [
            (Flags::BOLD, ";1"),
            (Flags::DIM, ";2"),
            (Flags::ITALIC, ";3"),
            (Flags::INVERSE, ";7"),
            (Flags::HIDDEN, ";8"),
            (Flags::STRIKEOUT, ";9"),
        ];
        for (flag, code) in flags {
            if self.flags.contains(flag) {
                out.push_str(code);
            }
        }
        // One underline style (alacritty keeps one at a time); `4:n` as xterm.js reads it.
        let underline = [
            (Flags::UNDERLINE, ";4"),
            (Flags::DOUBLE_UNDERLINE, ";4:2"),
            (Flags::UNDERCURL, ";4:3"),
            (Flags::DOTTED_UNDERLINE, ";4:4"),
            (Flags::DASHED_UNDERLINE, ";4:5"),
        ];
        if let Some((_, code)) = underline
            .iter()
            .find(|(flag, _)| self.flags.contains(*flag))
        {
            out.push_str(code);
        }
        write_color(out, self.fg, ColorKind::Foreground);
        write_color(out, self.bg, ColorKind::Background);
        if let Some(color) = self.underline {
            write_color(out, color, ColorKind::Underline);
        }
        out.push('m');
    }
}

#[derive(Debug, Clone, Copy)]
enum ColorKind {
    Foreground,
    Background,
    Underline,
}

/// `;31`, `;91`, `;38;5;n`, `;38;2;r;g;b` (and the background and underline forms). The
/// default colors write nothing: the reset before them already chose them.
fn write_color(out: &mut String, color: Color, kind: ColorKind) {
    let (base, bright, extended) = match kind {
        ColorKind::Foreground => (Some(30), Some(90), 38),
        ColorKind::Background => (Some(40), Some(100), 48),
        // Underline colors have no short form.
        ColorKind::Underline => (None, None, 58),
    };
    match color {
        Color::Named(name) => {
            let Some(index) = palette_index(name) else {
                return;
            };
            match (index, base, bright) {
                (0..=7, Some(base), _) => {
                    let _ = write!(out, ";{}", base + u16::from(index));
                }
                (8..=15, _, Some(bright)) => {
                    let _ = write!(out, ";{}", bright + u16::from(index - 8));
                }
                _ => {
                    let _ = write!(out, ";{extended};5;{index}");
                }
            }
        }
        Color::Indexed(index) => {
            let _ = write!(out, ";{extended};5;{index}");
        }
        Color::Spec(rgb) => {
            let _ = write!(out, ";{extended};2;{};{};{}", rgb.r, rgb.g, rgb.b);
        }
    }
}

/// A named color's palette index (0–15); `None` for the default foreground, background and
/// cursor colors. The dim variants are their normal color (dimness is the `DIM` flag).
fn palette_index(name: NamedColor) -> Option<u8> {
    use NamedColor as N;
    let index = match name {
        N::Black | N::DimBlack => 0,
        N::Red | N::DimRed => 1,
        N::Green | N::DimGreen => 2,
        N::Yellow | N::DimYellow => 3,
        N::Blue | N::DimBlue => 4,
        N::Magenta | N::DimMagenta => 5,
        N::Cyan | N::DimCyan => 6,
        N::White | N::DimWhite => 7,
        N::BrightBlack => 8,
        N::BrightRed => 9,
        N::BrightGreen => 10,
        N::BrightYellow => 11,
        N::BrightBlue => 12,
        N::BrightMagenta => 13,
        N::BrightCyan => 14,
        N::BrightWhite => 15,
        _ => return None,
    };
    Some(index)
}

/// A cell that draws nothing: a space (or a tab's first cell) on the default background,
/// without the attributes that show on a space.
fn is_blank(cell: &Cell) -> bool {
    matches!(cell.c, ' ' | '\t')
        && cell.bg == Color::Named(NamedColor::Background)
        && !cell
            .flags
            .intersects(Flags::INVERSE | Flags::ALL_UNDERLINES | Flags::STRIKEOUT)
        && cell.zerowidth().is_none_or(<[char]>::is_empty)
}

/// Where a row's content ends (trailing blank cells are left out).
pub(crate) fn content_end(row: &Row<Cell>, cols: usize) -> usize {
    (0..cols)
        .rev()
        .find(|&col| !is_blank(&row[Column(col)]))
        .map_or(0, |col| col + 1)
}

pub(crate) fn is_wrapped(row: &Row<Cell>, cols: usize) -> bool {
    cols > 0 && row[Column(cols - 1)].flags.contains(Flags::WRAPLINE)
}

/// One row: its cells with SGR changes, then a reset and `\r\n` (a wrapped row continues on
/// the next one instead, unless it is the last row).
fn encode_row(row: &Row<Cell>, cols: usize, dim: bool, last: bool) -> String {
    let wrapped = !last && is_wrapped(row, cols);
    let end = if wrapped {
        cols
    } else {
        content_end(row, cols)
    };
    let mut out = encode_cells(row, end, dim);
    if !wrapped {
        out.push_str("\r\n");
    }
    out
}

/// The first `end` cells of a row with their SGR changes, ending with a reset when the last
/// style was not plain.
pub(crate) fn encode_cells(row: &Row<Cell>, end: usize, dim: bool) -> String {
    let mut out = String::new();
    let mut current = Style::PLAIN;
    for col in 0..end {
        let cell = &row[Column(col)];
        // The second half of a wide character, or the gap before one that wrapped.
        if cell
            .flags
            .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
        {
            continue;
        }
        let style = Style::of(cell, dim);
        if style != current {
            style.write_sgr(&mut out);
            current = style;
        }
        // A tab's cell is a space here: the cells after it are written too.
        out.push(if cell.c.is_control() { ' ' } else { cell.c });
        if let Some(marks) = cell.zerowidth() {
            out.extend(marks.iter().filter(|c| !c.is_control()));
        }
    }
    if current != Style::PLAIN {
        out.push_str("\x1b[0m");
    }
    out
}

/// The grid as VT bytes, oldest row first, capped by `options` (the newest rows are kept).
/// The empty rows below the last output are left out; an empty terminal gives no bytes.
pub(crate) fn serialize<T>(term: &Term<T>, options: SnapshotOptions) -> Vec<u8> {
    let grid = term.grid();
    let cols = term.columns();
    let history = i32::try_from(grid.history_size()).unwrap_or(i32::MAX);
    let rows = i32::try_from(term.screen_lines()).unwrap_or(i32::MAX);
    let mut last = rows - 1;
    while last >= -history && content_end(&grid[Line(last)], cols) == 0 {
        last -= 1;
    }
    if last < -history || options.max_lines == 0 {
        return Vec::new();
    }
    let count = i32::try_from(options.max_lines).unwrap_or(i32::MAX);
    let first = last.saturating_sub(count - 1).max(-history);
    let lines: Vec<String> = (first..=last)
        .map(|row| encode_row(&grid[Line(row)], cols, options.dim, row == last))
        .collect();
    // The newest rows that fit in the byte budget.
    let mut total = 0;
    let mut keep = lines.len();
    for (index, line) in lines.iter().enumerate().rev() {
        if total + line.len() > options.max_bytes {
            break;
        }
        total += line.len();
        keep = index;
    }
    lines[keep..].concat().into_bytes()
}

/// What a new session of the panel shows first: the snapshot (dim when it was saved with
/// `dim`), then a dim divider `── restored from <label> ──` on its own line. The shell's own
/// output follows below it. Nothing for an empty snapshot.
pub fn restored(body: &[u8], label: &str) -> Vec<u8> {
    if body.is_empty() {
        return Vec::new();
    }
    let label: String = label.chars().filter(|c| !c.is_control()).collect();
    let mut out = Vec::with_capacity(body.len() + 64);
    out.extend_from_slice(b"\x1b[0m");
    out.extend_from_slice(body);
    if !body.ends_with(b"\r\n") {
        out.extend_from_slice(b"\x1b[0m\r\n");
    }
    out.extend_from_slice(format!("\x1b[0;2m── restored from {label} ──\x1b[0m\r\n").as_bytes());
    out
}

/// A snapshot file: a short header (version and save time) and the VT bytes.
pub fn encode(saved_at: u64, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(FILE_MAGIC.len() + 21 + body.len());
    out.extend_from_slice(FILE_MAGIC);
    out.extend_from_slice(saved_at.to_string().as_bytes());
    out.push(b'\n');
    out.extend_from_slice(body);
    out
}

/// The save time and VT bytes of a snapshot file; `None` for anything else (another version,
/// a damaged header).
pub fn decode(file: &[u8]) -> Option<(u64, &[u8])> {
    let rest = file.strip_prefix(FILE_MAGIC)?;
    let newline = rest.iter().position(|&b| b == b'\n')?;
    let saved_at = std::str::from_utf8(&rest[..newline]).ok()?.parse().ok()?;
    Some((saved_at, &rest[newline + 1..]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Terminal, TerminalSize};

    fn term(cols: u16, rows: u16) -> Terminal {
        Terminal::new(TerminalSize { cols, rows }, 10_000)
    }

    const EXACT: SnapshotOptions = SnapshotOptions {
        max_lines: MAX_LINES,
        max_bytes: MAX_BYTES,
        dim: false,
    };

    fn text(bytes: &[u8]) -> String {
        String::from_utf8(bytes.to_vec()).expect("snapshots are UTF-8")
    }

    #[test]
    fn round_trip_keeps_text_and_sgr() {
        let mut a = term(40, 6);
        a.advance(
            "plain\r\n\x1b[1;31mbold red\x1b[0m \x1b[38;5;208mindexed\x1b[0m \x1b[38;2;1;2;3;48;2;4;5;6mrgb\x1b[0m\r\n\x1b[3;4mitalic under\x1b[0m \x1b[7m \x1b[0m é✓ 漢字\r\n"
                .as_bytes(),
        );
        let first = a.snapshot_with(EXACT).expect("main screen");
        assert!(text(&first).contains("\x1b[0;1;31mbold red"));
        assert!(text(&first).contains("\x1b[0;38;5;208mindexed"));
        assert!(text(&first).contains("\x1b[0;38;2;1;2;3;48;2;4;5;6mrgb"));

        let mut b = term(40, 6);
        b.advance(&first);
        assert_eq!(b.screen_text(), a.screen_text());
        assert_eq!(b.snapshot_with(EXACT).expect("main screen"), first);
    }

    #[test]
    fn wrapped_rows_are_joined_and_reflow() {
        let mut a = term(10, 5);
        a.advance(b"0123456789abcde\r\n");
        let body = a.snapshot_with(EXACT).expect("main screen");
        assert_eq!(text(&body), "0123456789abcde\r\n");

        let mut narrow = term(5, 6);
        narrow.advance(&body);
        assert_eq!(narrow.recent_text(10), ["01234", "56789", "abcde"]);
    }

    #[test]
    fn tabs_and_trailing_blanks() {
        let mut a = term(20, 3);
        a.advance(b"a\tb   \r\n");
        assert_eq!(
            text(&a.snapshot_with(EXACT).expect("main screen")),
            "a       b\r\n"
        );
        assert_eq!(term(20, 3).snapshot_with(EXACT), Some(Vec::new()));
    }

    #[test]
    fn caps_keep_the_newest_lines() {
        let mut a = term(20, 5);
        for n in 1..=50 {
            a.advance(format!("line {n}\r\n").as_bytes());
        }
        let lines = a
            .snapshot_with(SnapshotOptions {
                max_lines: 10,
                ..EXACT
            })
            .expect("main screen");
        let expected = (41..=50).fold(String::new(), |mut all, n| {
            let _ = write!(all, "line {n}\r\n");
            all
        });
        assert_eq!(text(&lines), expected);

        // "line NN\r\n" is 9 bytes: 30 bytes keep three whole lines.
        let bytes = a
            .snapshot_with(SnapshotOptions {
                max_bytes: 30,
                ..EXACT
            })
            .expect("main screen");
        assert_eq!(text(&bytes), "line 48\r\nline 49\r\nline 50\r\n");

        let mut long = term(20, 5);
        for n in 1..=3_000 {
            long.advance(format!("{n}\r\n").as_bytes());
        }
        let capped = long.snapshot(true).expect("main screen");
        let rows = capped.windows(2).filter(|w| w == b"\r\n").count();
        assert_eq!(rows, MAX_LINES);
        assert!(capped.len() <= MAX_BYTES);
        assert!(text(&capped).contains("3000"));
    }

    #[test]
    fn restored_snapshot_is_dim_above_the_divider() {
        let mut a = term(40, 4);
        a.advance(b"\x1b[31mred\x1b[0m plain\r\n");
        let body = a.snapshot(true).expect("main screen");
        let shown = restored(&body, "2026-10-12 18:05");

        let mut b = term(40, 4);
        b.advance(&shown);
        b.advance(b"PS> ");
        assert_eq!(
            b.recent_text(10),
            ["red plain", "── restored from 2026-10-12 18:05 ──", "PS>"]
        );
        // Every restored cell is dim; the new shell's output is not.
        assert_eq!(
            text(&b.snapshot_with(EXACT).expect("main screen")),
            "\x1b[0;2;31mred\x1b[0;2m plain\x1b[0m\r\n\x1b[0;2m── restored from 2026-10-12 18:05 ──\x1b[0m\r\nPS>\r\n"
        );
        assert_eq!(restored(b"", "now").len(), 0);
        // A label can't smuggle control sequences in.
        assert!(!text(&restored(b"x\r\n", "\x1b]0;t\x07")).contains("\x1b]"));
    }

    #[test]
    fn changes_are_reported_once() {
        let mut a = term(20, 3);
        assert!(!a.take_changed());
        a.advance(b"x");
        assert!(a.take_changed());
        assert!(!a.take_changed());
    }

    #[test]
    fn alternate_screen_is_not_saved() {
        let mut a = term(20, 3);
        a.advance(b"shell output\r\n\x1b[?1049hvim");
        assert_eq!(a.snapshot(true), None);
        a.advance(b"\x1b[?1049l");
        assert!(a.snapshot(true).is_some());
    }

    #[test]
    fn file_header_round_trip() {
        let file = encode(1_760_000_000, b"\x1b[0;2mhi\x1b[0m\r\n");
        assert_eq!(
            decode(&file),
            Some((1_760_000_000, &b"\x1b[0;2mhi\x1b[0m\r\n"[..]))
        );
        assert_eq!(decode(b"WCMDSB2 1\nx"), None);
        assert_eq!(decode(b"WCMDSB1 soon\nx"), None);
        assert_eq!(decode(b"WCMDSB1 12"), None);
        assert_eq!(decode(&encode(5, b"")), Some((5, &b""[..])));
    }
}
