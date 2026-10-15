# wcmd-config

**Purpose:** the user's settings (`settings.toml`) and crash-safe whole-file writes used by every file WolfCmd saves.

## Public API
- `Settings { version, appearance, terminal, agents, window }`: `AppearanceSettings` (theme: Dark Modern by default, Light or Auto; font family and size, cursor, N-02 `smooth_scroll`, N-06 `finish_glow`: an agent's panel glows once in its color when it finishes while the user isn't looking at it, on by default), `TerminalSettings` (N-07 `default_profile`: a profile ID, empty for automatic; N-02 `kitty_keyboard`, off by default), `AgentSettings` (Remote Control, per project), N-01 `WindowSettings` (`close_to_tray`: closing the window hides WolfCmd to the tray, on by default; `tray_hint_shown`: the one hint about it was shown; N-11 `confirm_close`: closing what runs and quitting with a running agent ask first, on by default). `Settings::normalized()` brings values into range (font size between `FONT_SIZE_MIN` and `FONT_SIZE_MAX`). `Theme`, `Cursor`, `CURRENT_VERSION`.
- `SettingsFile::in_dir(dir)`, `path()`, `load() -> SettingsLoaded { settings, read_only: Option<SettingsReadOnly>, set_aside }`, `save(&Settings)`. Only a missing file means the defaults with saving allowed. An unreadable file (retried 3×) gives the defaults and `SettingsReadOnly::Unreadable`; a damaged one (bad TOML or UTF-8) is copied (not renamed) to `settings.broken-<seconds>.toml` and stays until the next save, with `SettingsReadOnly::NotSetAside` when that copy fails. `SettingsReadOnly`'s `Display` is the text the UI gets.
- `fs::write_atomic(path, bytes)`: writes a flushed temporary sibling and moves it over the old file, so a crash or power cut leaves the old or the new file, never half. The Windows half is `src/platform/windows.rs`.

## Depends on / used by
- Depends on: `serde`, `toml`, `specta`, `tracing`, `windows` (file APIs).
- Used by: `wcmd-app` (settings commands), `wcmd-state` and `wcmd-pty` (`write_atomic`).

## Invariants
- Every saved file goes through `write_atomic`; never write a user file with a plain `std::fs::write`.
- Never overwrite a settings file that could not be read or kept aside: the caller saves nothing while `read_only` is set.
- `Settings` is a persisted format: a change old files can't read needs a version bump (`CURRENT_VERSION`), a migration and a test. New fields have defaults.
- Remote Control per project lives here, never in a project's own files, so a cloned repository can't turn remote access on.
- The Rust types are the contract: the UI's types are generated from them (`pnpm gen:bindings`).

## How to test
- `cargo test -p wcmd-config`.
