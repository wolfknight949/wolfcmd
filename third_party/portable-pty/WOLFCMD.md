# portable-pty 0.9.0, patched for WolfCmd

This is portable-pty 0.9.0 from crates.io (MIT, `LICENSE.md`), used through `[patch.crates-io]` in the root `Cargo.toml`. One change: `src/win/psuedocon.rs` creates the pseudo console without `PSEUDOCONSOLE_RESIZE_QUIRK`, so ConPTY repaints the screen after a resize.

The quirk tells ConPTY that the terminal reflows its buffer exactly like conhost, so ConPTY does not repaint the screen after a resize. Windows Terminal does that; xterm.js does not. With the quirk, a full-screen program resized in WolfCmd (Claude Code while the window is maximized) keeps stale rows from its last frame, because ConPTY sends only the cells it thinks have changed.

The guard test is `crates/wcmd-pty/tests/vendored_portable_pty.rs`. When updating portable-pty: copy the new release here, apply the same change, keep this file, and run that test.
