# N-07: Settings

> Status: Implemented · [Roadmap](../ROADMAP.md) N-07: one small dialog: theme, font and size, default shell, agents. The app is about working with one or two terminals; every setting must earn its place.

## Goal
One calm dialog of grouped settings rows (not a web form) for the few settings WolfCmd has. Every change applies at once and is saved crash-safe; there is no OK/Cancel, only Close.

## Opening it
- The gear at the foot of the right bar: a registered bar item with `placement: "bottom"` (`chrome/bar.ts`; the bar splits its items by placement, never by ID).
- Ctrl+, (Cmd+, on macOS, `primaryModifier`) in `keys.ts`.
- Settings… at the end of the workspace menu.
- `chrome/settings-open.ts` holds whether it is open and where the focus goes back (the button, the menu's trigger, or for Ctrl+, whatever had the keyboard: usually the terminal). The bar item renders the dialog.

## Sections (one scrollable dialog, section headers, a card per setting)
- **Appearance:** Theme (segmented: Dark Modern, Light, Auto); Font (text field plus a menu of the installed monospace families; a line says when the family is missing or not monospaced); Font size (NumberBox 9–28; Ctrl+= / Ctrl+- change the same setting and the box follows); Cursor (Bar, Block, Underline); Smooth scrolling; N-06 Glow the panel when an agent finishes (`appearance.finish_glow`, on by default: the finished agent's panel glows once in its color).
- **Terminal:** Default shell (Automatic or an installed profile; the line says what new terminals run); Kitty keyboard protocol (off; one line on what it is for).
- **Agents:** Remote Control (the global default; per workspace stays in the workspace menu); Notify when an agent finishes.
- **Window** (N-01): Keep running in the tray when closed (`window.close_to_tray`, on by default; macOS: "Keep running when closed", the Dock's way). Off: the window's ✕ quits as before.
- **About:** the version (and the build's commit) and the data folder with Open. No update checks (distribution is winget); no log folder exists (logs go to the console).

## Core
- `wcmd-config`: new `terminal.default_profile: String` (empty: automatic; trimmed by `normalized()`), a default and a load test. No version bump (a new field with a default).
- `wcmd-pty`: `default_profile_preferring(setting)`: `WOLFCMD_DEFAULT_PROFILE` first (the e2e tests rely on it), then the setting when that profile is installed, then the first installed. Pure `choose_default` is unit tested.
- `wcmd-app`: the session host asks the setting at each start without a profile (`with_default_profile`), and so do the profile list's default mark and `agent_command`. New commands `app_about` and `app_open_data_folder` (the core opens the folder; the page never touches files).

## UI
- ui-kit: `ToggleSwitch`, `Segmented` (native radios: one Tab stop, arrows), `NumberBox`; `Dialog` gets `size: "wide"` and now returns the focus to what had it before it rendered (an `autoFocus` field inside used to win).
- `store/settings.ts`: `changed(settings, part, patch)`; saves run one at a time and then only the newest, so a quick series never lands out of order; `saved()` lets the dialog read the profiles again once the default shell is saved.
- The font field applies on Enter, on blur, when it names an installed family, or when a family is picked; never per keystroke (each change restyles and refits every terminal).
- `chrome/fonts.ts`: a fixed list of known monospace families checked with canvas text widths (a missing family measures like its fallback); no system call, no permission.

## Tests
- Rust: the setting's default and a file without it; `choose_default` order; the session host runs and marks the setting's shell.
- TS: each control changes the store (`SettingsDialog.test.tsx`), the bar button opens it and Esc closes it with the focus back, Ctrl+, opens it, bar placement, the store's ordered saves, font checks; ui-kit control tests.
- E2E (`tests/e2e/src/settings.e2e.ts`): Ctrl+,, Light changes `data-theme` and the terminal's colors, a bigger font redraws the terminal and reflows the shell once, Esc closes it, a restart keeps both.

## As built
- N-01 (closing the window hides it to the tray instead of quitting): `[window] close_to_tray` (default on) and `tray_hint_shown` (the one hint about the tray was shown; not in the dialog), defaults and a load test in `wcmd-config`; no version bump. The Window section holds the toggle. Ctrl+Q (Cmd+Q) quits.
- One scrollable dialog (640 px at most) rather than a list of sections on the left: nine settings read better in one column.
- The selected segment is a raised chip (N-01's look).
