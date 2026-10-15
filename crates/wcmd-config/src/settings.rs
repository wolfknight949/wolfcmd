//! N-07: `settings.toml` in the data folder. Every section and key has a default, so a missing
//! or partial file always loads. Keys are permanent: a rename or removal needs a migration step
//! and a test.

use std::collections::BTreeMap;
use std::fmt;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// The file format's version (1: the first format, ADR-0001).
pub const CURRENT_VERSION: u32 = 1;
pub const FONT_SIZE_MIN: u32 = 9;
pub const FONT_SIZE_MAX: u32 = 28;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(default)]
pub struct Settings {
    pub version: u32,
    pub appearance: AppearanceSettings,
    pub terminal: TerminalSettings,
    pub agents: AgentSettings,
    /// N-01: what closing the window does.
    pub window: WindowSettings,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: CURRENT_VERSION,
            appearance: AppearanceSettings::default(),
            terminal: TerminalSettings::default(),
            agents: AgentSettings::default(),
            window: WindowSettings::default(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    /// Follows the system's light or dark mode.
    Auto,
    /// N-01: VS Code's Dark Modern, the default.
    Dark,
    Light,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum Cursor {
    Bar,
    Block,
    Underline,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(default)]
pub struct AppearanceSettings {
    pub theme: Theme,
    /// The terminal font; empty: the built-in stack (Cascadia Mono, Consolas, monospace).
    pub font_family: String,
    pub font_size: u32,
    pub cursor: Cursor,
    /// N-02: the mouse wheel scrolls terminals with a short glide (none when the system
    /// reduces motion).
    pub smooth_scroll: bool,
    /// N-06: an agent's panel glows once in the agent's color when it finishes while the user
    /// isn't looking at it (none when the system reduces motion).
    pub finish_glow: bool,
}

impl Default for AppearanceSettings {
    fn default() -> Self {
        Self {
            theme: Theme::Dark,
            font_family: String::new(),
            font_size: 14,
            cursor: Cursor::Bar,
            smooth_scroll: true,
            finish_glow: true,
        }
    }
}

/// N-02: how terminals behave.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, specta::Type)]
#[serde(default)]
pub struct TerminalSettings {
    /// N-07: the shell profile a new terminal runs (`pwsh`, `cmd`, `git-bash`, `wsl.Ubuntu`…).
    /// Empty: automatic (PowerShell 7, else Windows PowerShell, else Command Prompt). A profile
    /// that isn't installed any more counts as empty.
    pub default_profile: String,
    /// The Kitty keyboard protocol for programs that ask for it (`CSI > flags u`). Off: such
    /// programs see a terminal without it and get the usual key bytes.
    pub kitty_keyboard: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(default)]
pub struct AgentSettings {
    /// N-06: agents start with their own Remote Control (Claude Code) in every workspace…
    pub remote_control: bool,
    /// …unless a workspace's folder says otherwise (folder key → always / never). Kept here,
    /// never in the folder's own files, so a cloned repository can't turn remote access on.
    pub remote_control_folders: BTreeMap<String, bool>,
    /// N-06: an agent that finished while the window wasn't in front shows a system
    /// notification (only the agent's and the tab's names). The taskbar button flashes either way.
    pub notify_when_done: bool,
}

impl Default for AgentSettings {
    fn default() -> Self {
        Self {
            remote_control: false,
            remote_control_folders: BTreeMap::new(),
            notify_when_done: true,
        }
    }
}

/// N-01: closing the window (its ✕, Alt+F4, the taskbar's Close).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(default)]
pub struct WindowSettings {
    /// Closing hides WolfCmd to the system tray (macOS: the Dock) and its terminals and agents
    /// keep running; Quit is in the tray's menu and Ctrl+Q. Off: closing quits.
    pub close_to_tray: bool,
    /// The one hint about the tray ("still running in the tray") was shown; never again.
    pub tray_hint_shown: bool,
    /// N-11: closing a panel, tab or workspace with a running agent (or a running command in a
    /// shell with integration), and quitting with a running agent, asks first. Off: never asks.
    pub confirm_close: bool,
}

impl Default for WindowSettings {
    fn default() -> Self {
        Self {
            close_to_tray: true,
            tray_hint_shown: false,
            confirm_close: true,
        }
    }
}

impl Settings {
    /// Values brought into their ranges (a hand-edited file can hold anything).
    #[must_use]
    pub fn normalized(mut self) -> Self {
        self.version = CURRENT_VERSION;
        self.appearance.font_size = self
            .appearance
            .font_size
            .clamp(FONT_SIZE_MIN, FONT_SIZE_MAX);
        self.appearance.font_family = self.appearance.font_family.trim().to_owned();
        self.terminal.default_profile = self.terminal.default_profile.trim().to_owned();
        self.agents
            .remote_control_folders
            .retain(|folder, _| !folder.trim().is_empty());
        self
    }
}

/// The pauses between read attempts when the file exists but can't be read (another program
/// holding it, a slow disk).
const READ_RETRIES: [Duration; 3] = [
    Duration::from_millis(50),
    Duration::from_millis(150),
    Duration::from_millis(400),
];

/// N-07: why a run must never save the settings file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettingsReadOnly {
    /// It exists but couldn't be read: saving would replace what we never saw.
    Unreadable { error: String },
    /// It doesn't parse and couldn't be copied aside: saving would replace the only copy.
    NotSetAside { error: String },
}

impl fmt::Display for SettingsReadOnly {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unreadable { error } => write!(
                f,
                "WolfCmd couldn't read settings.toml ({error}). Changes to the settings aren't \
                 saved, so the file stays as it is. Restart WolfCmd once the file can be read."
            ),
            Self::NotSetAside { error } => write!(
                f,
                "settings.toml is damaged and couldn't be copied aside ({error}). Changes to \
                 the settings aren't saved, so the file stays as it is."
            ),
        }
    }
}

/// What [`SettingsFile::load`] found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingsLoaded {
    /// The saved settings, or the defaults when there are none that can be used.
    pub settings: Settings,
    /// Why nothing may be saved this run; `None` when saving is safe.
    pub read_only: Option<SettingsReadOnly>,
    /// Where a damaged file was copied (the file itself stays until the next save).
    pub set_aside: Option<PathBuf>,
}

/// The settings file in a data folder.
#[derive(Debug, Clone)]
pub struct SettingsFile {
    path: PathBuf,
}

impl SettingsFile {
    pub fn in_dir(dir: &Path) -> Self {
        Self {
            path: dir.join("settings.toml"),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The saved settings, or the defaults. Never fails, and never loses the user's file:
    /// - Only a missing file means the defaults with saving allowed.
    /// - Any other read error is retried ([`READ_RETRIES`]); then the defaults are used and the
    ///   run is read-only ([`SettingsReadOnly::Unreadable`]).
    /// - A file that doesn't parse (or isn't UTF-8) is *copied* aside as
    ///   `settings.broken-<seconds>.toml` and the defaults are used; it stays until the next
    ///   save replaces it. When the copy fails the run is read-only
    ///   ([`SettingsReadOnly::NotSetAside`]).
    pub fn load(&self) -> SettingsLoaded {
        let loaded = |settings, read_only, set_aside| SettingsLoaded {
            settings,
            read_only,
            set_aside,
        };
        let bytes = match read_retrying(&self.path) {
            Ok(Some(bytes)) => bytes,
            Ok(None) => return loaded(Settings::default(), None, None),
            Err(error) => {
                tracing::error!(%error, "N-07: settings.toml can't be read; it won't be saved");
                let read_only = SettingsReadOnly::Unreadable {
                    error: error.to_string(),
                };
                return loaded(Settings::default(), Some(read_only), None);
            }
        };
        let parsed = std::str::from_utf8(&bytes)
            .map_err(|error| error.to_string())
            .and_then(|text| toml::from_str::<Settings>(text).map_err(|error| error.to_string()));
        match parsed {
            Ok(settings) => loaded(settings.normalized(), None, None),
            Err(error) => {
                tracing::warn!(%error, "N-07: settings.toml doesn't parse; copying it aside");
                match self.copy_aside(&bytes) {
                    Ok(aside) => loaded(Settings::default(), None, Some(aside)),
                    Err(error) => {
                        tracing::error!(%error, "N-07: could not copy the damaged settings.toml");
                        let read_only = SettingsReadOnly::NotSetAside {
                            error: error.to_string(),
                        };
                        loaded(Settings::default(), Some(read_only), None)
                    }
                }
            }
        }
    }

    /// Keeps the file's bytes as `settings.broken-<seconds>.toml` (a new name each time),
    /// flushed to the disk before the original may be replaced.
    fn copy_aside(&self, bytes: &[u8]) -> std::io::Result<PathBuf> {
        let seconds = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        let mut n = 0;
        let aside = loop {
            let suffix = if n == 0 {
                String::new()
            } else {
                format!("-{n}")
            };
            let aside = self
                .path
                .with_file_name(format!("settings.broken-{seconds}{suffix}.toml"));
            if !aside.exists() {
                break aside;
            }
            n += 1;
        };
        crate::fs::write_atomic(&aside, bytes)?;
        Ok(aside)
    }

    /// Writes the whole file (crash-safe).
    pub fn save(&self, settings: &Settings) -> std::io::Result<()> {
        let text = toml::to_string_pretty(&settings.clone().normalized())
            .map_err(std::io::Error::other)?;
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        crate::fs::write_atomic(&self.path, text.as_bytes())
    }
}

/// The file's bytes; `None` only when it doesn't exist. Other errors are retried
/// ([`READ_RETRIES`]) before they are returned.
fn read_retrying(path: &Path) -> std::io::Result<Option<Vec<u8>>> {
    let mut pauses = READ_RETRIES.iter();
    loop {
        match std::fs::read(path) {
            Ok(bytes) => return Ok(Some(bytes)),
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => match pauses.next() {
                Some(pause) => {
                    tracing::warn!(%error, "N-07: settings.toml can't be read yet; retrying");
                    std::thread::sleep(*pause);
                }
                None => return Err(error),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wcmd-config-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn n07_a_missing_file_loads_the_defaults() {
        let file = SettingsFile::in_dir(&temp_dir("missing"));
        assert_eq!(file.load().settings, Settings::default());
    }

    #[test]
    fn n07_settings_round_trip_and_partial_files_keep_defaults() {
        let dir = temp_dir("round");
        let file = SettingsFile::in_dir(&dir);
        std::fs::write(file.path(), "[appearance]\nfont_size = 40\n").unwrap();
        let loaded = file.load().settings;
        assert_eq!(loaded.appearance.font_size, FONT_SIZE_MAX);
        assert_eq!(loaded.appearance.theme, Theme::Dark);
        let mut settings = loaded;
        settings.agents.remote_control = true;
        settings
            .agents
            .remote_control_folders
            .insert("c:/dev/game".into(), false);
        file.save(&settings).unwrap();
        assert_eq!(file.load().settings, settings);
    }

    #[test]
    fn n02_terminal_keys_default_and_round_trip() {
        let dir = temp_dir("terminal");
        let file = SettingsFile::in_dir(&dir);
        // A file from before these keys: smooth scrolling on, the Kitty protocol off.
        std::fs::write(file.path(), "[appearance]\nfont_size = 13\n").unwrap();
        let loaded = file.load().settings;
        assert!(loaded.appearance.smooth_scroll);
        assert!(!loaded.terminal.kitty_keyboard);
        let mut settings = loaded;
        settings.appearance.smooth_scroll = false;
        settings.terminal.kitty_keyboard = true;
        file.save(&settings).unwrap();
        assert_eq!(file.load().settings, settings);
    }

    #[test]
    fn n06_finish_glow_defaults_on_and_round_trips() {
        assert!(Settings::default().appearance.finish_glow);
        let dir = temp_dir("finish-glow");
        let file = SettingsFile::in_dir(&dir);
        // A file from before the key: the glow on.
        std::fs::write(file.path(), "[appearance]\nsmooth_scroll = false\n").unwrap();
        let loaded = file.load().settings;
        assert!(loaded.appearance.finish_glow);
        assert!(!loaded.appearance.smooth_scroll);
        let mut settings = loaded;
        settings.appearance.finish_glow = false;
        file.save(&settings).unwrap();
        assert_eq!(file.load().settings, settings);
        std::fs::write(file.path(), "[appearance]\nfinish_glow = false\n").unwrap();
        assert!(!file.load().settings.appearance.finish_glow);
    }

    #[test]
    fn n01_close_to_tray_defaults_on_and_round_trips() {
        let defaults = Settings::default().window;
        assert!(defaults.close_to_tray);
        assert!(!defaults.tray_hint_shown);
        let dir = temp_dir("close-to-tray");
        let file = SettingsFile::in_dir(&dir);
        // A file from before the section: closing hides to the tray, the hint not shown yet.
        std::fs::write(file.path(), "[appearance]\nfinish_glow = false\n").unwrap();
        let loaded = file.load().settings;
        assert_eq!(loaded.window, defaults);
        assert!(!loaded.appearance.finish_glow);
        let mut settings = loaded;
        settings.window.close_to_tray = false;
        settings.window.tray_hint_shown = true;
        file.save(&settings).unwrap();
        assert_eq!(file.load().settings, settings);
        std::fs::write(file.path(), "[window]\ntray_hint_shown = true\n").unwrap();
        let loaded = file.load().settings.window;
        assert!(loaded.close_to_tray);
        assert!(loaded.tray_hint_shown);
    }

    #[test]
    fn n11_confirm_close_defaults_on_and_round_trips() {
        assert!(Settings::default().window.confirm_close);
        let dir = temp_dir("confirm-close");
        let file = SettingsFile::in_dir(&dir);
        // A file from before the setting: closing what runs asks.
        std::fs::write(file.path(), "[window]\nclose_to_tray = false\n").unwrap();
        let loaded = file.load().settings;
        assert!(loaded.window.confirm_close);
        assert!(!loaded.window.close_to_tray);
        let mut settings = loaded;
        settings.window.confirm_close = false;
        file.save(&settings).unwrap();
        assert_eq!(file.load().settings, settings);
    }

    #[test]
    fn n07_default_profile_is_automatic_and_round_trips() {
        assert_eq!(Settings::default().terminal.default_profile, "");
        let dir = temp_dir("profile");
        let file = SettingsFile::in_dir(&dir);
        // A file from before the key: automatic.
        std::fs::write(file.path(), "[terminal]\nkitty_keyboard = true\n").unwrap();
        let loaded = file.load().settings;
        assert_eq!(loaded.terminal.default_profile, "");
        assert!(loaded.terminal.kitty_keyboard);
        let mut settings = loaded;
        settings.terminal.default_profile = " git-bash ".into();
        file.save(&settings).unwrap();
        assert_eq!(file.load().settings.terminal.default_profile, "git-bash");
    }

    #[test]
    fn n06_notify_when_done_defaults_on_and_round_trips() {
        assert!(Settings::default().agents.notify_when_done);
        let dir = temp_dir("notify");
        let file = SettingsFile::in_dir(&dir);
        // A file from before the key: on.
        std::fs::write(
            file.path(),
            "[agents]
remote_control = true
",
        )
        .unwrap();
        let loaded = file.load().settings;
        assert!(loaded.agents.notify_when_done);
        assert!(loaded.agents.remote_control);
        let mut settings = loaded;
        settings.agents.notify_when_done = false;
        file.save(&settings).unwrap();
        assert!(!file.load().settings.agents.notify_when_done);
    }

    #[test]
    fn n01_dark_modern_is_the_default_and_a_chosen_theme_stays() {
        assert_eq!(Settings::default().appearance.theme, Theme::Dark);
        let dir = temp_dir("theme");
        let file = SettingsFile::in_dir(&dir);
        for (text, theme) in [
            ("auto", Theme::Auto),
            ("light", Theme::Light),
            ("dark", Theme::Dark),
        ] {
            let toml = format!("[appearance]\ntheme = \"{text}\"\n");
            std::fs::write(file.path(), toml).unwrap();
            assert_eq!(file.load().settings.appearance.theme, theme);
        }
    }

    #[test]
    fn n07_a_missing_file_may_be_saved() {
        let loaded = SettingsFile::in_dir(&temp_dir("fresh")).load();
        assert_eq!(loaded.read_only, None);
        assert_eq!(loaded.set_aside, None);
    }

    /// A damaged file (bad TOML, or not UTF-8) is copied aside, not moved: the original stays
    /// until a save replaces it, and saving is allowed.
    #[test]
    fn n07_a_damaged_file_is_copied_aside_and_kept_until_a_save() {
        let dir = temp_dir("broken");
        let file = SettingsFile::in_dir(&dir);
        for damaged in [
            &b"not = [toml"[..],
            b"[appearance]\nfont_family = \"\xff\xfe\"\n",
        ] {
            std::fs::write(file.path(), damaged).unwrap();
            let loaded = file.load();
            assert_eq!(loaded.settings, Settings::default());
            assert_eq!(loaded.read_only, None);
            let aside = loaded.set_aside.expect("copied aside");
            let name = aside.file_name().unwrap().to_string_lossy().into_owned();
            assert!(
                name.starts_with("settings.broken-")
                    && aside.extension().is_some_and(|e| e == "toml"),
                "{name}"
            );
            assert_eq!(std::fs::read(&aside).unwrap(), damaged);
            assert_eq!(
                std::fs::read(file.path()).unwrap(),
                damaged,
                "the original stays"
            );
        }
        // Two copies the same second get their own names.
        let copies = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("settings.broken-")
            })
            .count();
        assert_eq!(copies, 2);
        file.save(&Settings::default()).unwrap();
        assert_eq!(file.load().settings, Settings::default());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A file another program holds without sharing can't be read: the defaults are used and
    /// the run is read-only, so it is never replaced; nothing is copied aside.
    #[cfg(windows)]
    #[test]
    fn n07_an_unreadable_file_makes_the_run_read_only() {
        use std::os::windows::fs::OpenOptionsExt as _;
        let dir = temp_dir("locked");
        let file = SettingsFile::in_dir(&dir);
        std::fs::write(file.path(), "[appearance]\nfont_size = 20\n").unwrap();
        let holder = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(file.path())
            .unwrap();
        let loaded = file.load();
        drop(holder);
        assert_eq!(loaded.settings, Settings::default());
        assert!(
            matches!(loaded.read_only, Some(SettingsReadOnly::Unreadable { .. })),
            "{:?}",
            loaded.read_only
        );
        assert_eq!(loaded.set_aside, None);
        assert_eq!(
            std::fs::read_to_string(file.path()).unwrap(),
            "[appearance]\nfont_size = 20\n"
        );
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
