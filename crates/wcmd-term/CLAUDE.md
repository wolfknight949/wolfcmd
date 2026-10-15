# wcmd-term

**Purpose:** the terminal's VT state in Rust (`alacritty_terminal`), fed with every byte the shell writes, so the core knows the screen and can save the scrollback.

## Public API
- `Terminal::new(size, scrollback)`, `advance(bytes)`, `resize(size)`, `size()`; `TerminalSize { cols, rows }`. Tests only: `screen_text()`, `recent_text(count)` (feature `test-util`, which `wcmd-app` enables for its tests) and `bracketed_paste()` (`#[cfg(test)]`).
- `take_cwd()`: the folder the shell reported (`OSC 7` file URL or `OSC 9;9`) since the last call (`src/cwd.rs`, a byte scanner beside the parser; split sequences are handled, payloads over 4 KiB skipped). Only folders on this machine (a drive, a POSIX path, a WSL disk): a network share or device path is refused, since any program can print a report and checking that folder would contact another machine.
- `take_title()`: N-06, the window title when it changed since the last call (empty when reset); agents show their working state there.
- `prompts()`: N-06, how many prompts the shell started (`OSC 133;A`, counted by the same scanner), so the core can tell that a command typed at one prompt has ended.
- `replay()`: what a fresh emulator needs to take over the session (`src/replay.rs`): scrollback (newest `MAX_REPLAY_BYTES`) and screen, the alternate screen, cursor and pen, input modes (`?1`, mouse 1000-1006, focus 1004, bracketed paste 2004, `?25`, `?7`, keypad), the title, then the start of an unfinished sequence the output ends inside of (`src/tail.rs`). Not dim.
- `snapshot(dim)`: the scrollback and screen as VT bytes (text and SGR; wrapped rows joined; the newest `MAX_LINES` rows within `MAX_BYTES`; `None` on the alternate screen); `take_changed()`: output was fed since the last call. Module `snapshot`: `restored(body, label)` (the body, then a dim divider), `encode` / `decode` (the `WCMDSB1 <unix seconds>` file header).

## Depends on / used by
- Depends on: `alacritty_terminal` only (a leaf: no `wcmd-*` deps).
- Used by: `wcmd-app` (the session host keeps one `Terminal` per panel).

## Invariants
- **Mirror only:** xterm.js answers terminal queries (DSR, DA, ...), so this crate never writes back to the PTY (its `Listener` keeps only the title and drops `PtyWrite`); both answering would duplicate replies.
- A zero size is clamped to 1x1.
- Never log `screen_text()`, `recent_text()` or a snapshot; it is terminal content.
- A snapshot holds only text, SGR sequences and line ends: nothing that changes modes, titles, links or the cursor (that is the replay's job). `replay()` takes `&mut self` only to read the primary screen behind the alternate one (swap and back); the state is unchanged afterwards (tested). `src/snapshot.rs` is pure (no I/O, no clock); where and when snapshots are saved is `wcmd-app`'s (`session/snapshot_store.rs`).

## How to test
- `cargo test -p wcmd-term`. The snapshot and replay round-trip tests feed their output to a second `Terminal` and compare.
