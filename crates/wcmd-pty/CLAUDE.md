# wcmd-pty

**Purpose:** spawns shells in pseudo consoles (ConPTY via `portable-pty`), finds the shell profiles on the machine, and starts built-in shells with shell integration.

## Public API
- `PtySession::spawn(profile, size, cwd) -> Spawned { session, writer, reader, child }`, `resize`, `kill`; `PtyWriter::write`; `PtySize`, `PtyError`; re-exports `portable_pty::Child`.
- Profiles: `installed_profiles()` (discovered once, cached), N-07 `default_profile_preferring(setting)` (`WOLFCMD_DEFAULT_PROFILE=<id>` first, `DEFAULT_PROFILE_ENV`, the e2e tests use `cmd`; then the user's `terminal.default_profile` when installed; then the first installed), `find_profile(id)`, `Profile`. Providers (Windows PowerShell, PowerShell 7, cmd, Git Bash, WSL distros, `SSH: <host>` from `~/.ssh/config`) are in `src/profiles/providers.rs`; registry reads in `src/platform/windows.rs`.
- Shell integration: `ShellIntegration::install(dir)` writes the scripts of `resources/shell-integration/`, `apply(&profile)` returns the profile started with them; `ShellKind`; `SHELL_INTEGRATION_ENV` (`WOLFCMD_SHELL_INTEGRATION=0` turns it off).
- `console_host()` / `ConsoleHost`: which console host (bundled OpenConsole or the system's) is active.

## Depends on / used by
- Depends on: `portable-pty` (the patched copy in `third_party/portable-pty`, without `PSEUDOCONSOLE_RESIZE_QUIRK`, so ConPTY repaints after a resize), `which`, `windows`, `wcmd-config` (`fs::write_atomic` for the scripts).
- Used by: `wcmd-app` (session host).

## Invariants
- `reader.read` blocks: always on a dedicated thread. `PtyWriter::write` blocks while the shell isn't reading: write from one dedicated thread.
- The slave handle is dropped right after spawning, or the console never finishes.
- Children get `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=WolfCmd`, plus the profile's `env`. Agent-session markers of WolfCmd's own environment (`is_agent_session_var`) are not passed on; the user's own settings (`ANTHROPIC_*`, `CLAUDE_CONFIG_DIR`, ...) are.
- Shell integration wraps the user's prompt and never edits their files. Scripts stay ASCII with LF endings (tests check). `WSL_LAUNCHER` stays one line of POSIX `sh`.
- `build.rs` copies `resources/conpty/<arch>/{conpty.dll,OpenConsole.exe}` next to every binary and test exe; `resources/conpty/README.md` says how to update them.

## How to test
- `cargo test -p wcmd-pty`. The tests in `tests/` spawn real shells and are Windows only.

## Gotchas
- **The reader never sees EOF when the shell exits.** Wait on `Spawned::child`, then drop `PtySession` (closes the console) to end the reader.
- ConPTY starts with `ESC[6n` (cursor position query) and waits for the answer. In the app xterm.js answers; tests must answer it themselves.
- portable-pty 0.9's Windows `kill()` inverts `TerminateProcess`'s result (Err on success). `PtySession::kill` ignores it; the child waiter is the source of truth.
- Git Bash maps `/tmp` to the user's temp folder and `/` to the Git folder: convert paths with the mount table, never by prefixing.
