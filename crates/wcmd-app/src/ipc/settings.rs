//! `settings` domain (N-07): `settings.toml` in the data folder.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use tauri::State;
use wcmd_config::{Settings, SettingsFile, SettingsReadOnly};

use crate::error::{ErrorKind, WcmdError};

/// The settings, read from the file once at start and kept here: every getter reads this copy
/// (a terminal start or an agent's end never touches the disk), and a save writes the file and
/// updates it. A file that couldn't be read or kept aside is never saved over this run
/// ([`SettingsReadOnly`]).
#[derive(Debug)]
pub(crate) struct SettingsService {
    file: SettingsFile,
    /// The current settings and why they may not be saved; held while saving, so saves run one
    /// at a time.
    current: Mutex<Current>,
}

#[derive(Debug)]
struct Current {
    settings: Settings,
    read_only: Option<SettingsReadOnly>,
}

impl SettingsService {
    pub(crate) fn in_dir(dir: &std::path::Path) -> Self {
        let file = SettingsFile::in_dir(dir);
        let loaded = file.load();
        if let Some(aside) = &loaded.set_aside {
            tracing::warn!(aside = %aside.display(), "N-07: the damaged settings were kept aside");
        }
        if let Some(reason) = &loaded.read_only {
            tracing::warn!(%reason, "N-07: settings changes won't be saved this run");
        }
        Self {
            file,
            current: Mutex::new(Current {
                settings: loaded.settings,
                read_only: loaded.read_only,
            }),
        }
    }

    fn current(&self) -> MutexGuard<'_, Current> {
        self.current.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The settings now.
    pub(crate) fn settings(&self) -> Settings {
        self.current().settings.clone()
    }

    /// N-03: the theme setting, for the window's first background.
    pub(crate) fn theme(&self) -> wcmd_config::Theme {
        self.current().settings.appearance.theme
    }

    /// N-07: the default shell setting (`None`: automatic). Asked at each terminal start, so a
    /// change applies to the next terminal.
    pub(crate) fn default_profile(&self) -> Option<String> {
        let id = self.current().settings.terminal.default_profile.clone();
        (!id.is_empty()).then_some(id)
    }

    /// N-06: the agent settings (whether a finished agent shows a notification).
    pub(crate) fn agents(&self) -> wcmd_config::AgentSettings {
        self.current().settings.agents.clone()
    }

    /// N-01: whether closing the window hides it to the tray (asked at each close).
    pub(crate) fn close_to_tray(&self) -> bool {
        self.current().settings.window.close_to_tray
    }

    /// N-11: whether quitting with a running agent asks first (asked at each tray Quit).
    pub(crate) fn confirm_close(&self) -> bool {
        self.current().settings.window.confirm_close
    }

    /// Applies `settings` (normalized) to this run and saves them. In a read-only run they
    /// apply but the file is left as it is, and the error says why.
    pub(crate) fn save(&self, settings: Settings) -> Result<Settings, WcmdError> {
        let settings = settings.normalized();
        let mut current = self.current();
        current.settings = settings.clone();
        if let Some(reason) = &current.read_only {
            tracing::warn!("N-07: a settings change was not saved (read-only run)");
            return Err(WcmdError::new(ErrorKind::Unavailable, reason.to_string()));
        }
        self.file
            .save(&settings)
            .map_err(|e| WcmdError::internal("could not save the settings", &e))?;
        Ok(settings)
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn settings_load(
    service: State<'_, Arc<SettingsService>>,
) -> Result<Settings, WcmdError> {
    Ok(service.settings())
}

/// Saves the whole settings (normalized) and returns what was saved.
#[tauri::command]
#[specta::specta]
pub(crate) async fn settings_save(
    service: State<'_, Arc<SettingsService>>,
    settings: Settings,
) -> Result<Settings, WcmdError> {
    service.save(settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("wcmd-app-settings-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn n07_getters_read_the_settings_kept_in_memory() {
        let dir = temp_dir("cache");
        let path = dir.join("settings.toml");
        std::fs::write(&path, "[terminal]\ndefault_profile = \"cmd\"\n").unwrap();
        let service = SettingsService::in_dir(&dir);
        // The file changes (or goes) behind the service's back: the getters don't read it.
        std::fs::write(&path, "[terminal]\ndefault_profile = \"pwsh\"\nnot = [toml").unwrap();
        assert_eq!(service.default_profile().as_deref(), Some("cmd"));
        assert_eq!(service.theme(), wcmd_config::Theme::Dark);
        assert!(service.agents().notify_when_done);
        assert!(service.close_to_tray());
        std::fs::remove_file(&path).unwrap();
        assert_eq!(service.default_profile().as_deref(), Some("cmd"));
        // Nothing was set aside by a getter.
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        // A save changes what they answer, and the file.
        let mut settings = service.settings();
        settings.terminal.default_profile = String::new();
        settings.agents.notify_when_done = false;
        settings.window.close_to_tray = false;
        service.save(settings).unwrap();
        assert_eq!(service.default_profile(), None);
        assert!(!service.agents().notify_when_done);
        // N-01: the next close quits.
        assert!(!service.close_to_tray());
        let saved = SettingsFile::in_dir(&dir).load().settings;
        assert!(!saved.agents.notify_when_done);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A settings file another program held at start is never saved over: the change applies
    /// to this run and the save says why it wasn't written.
    #[cfg(windows)]
    #[test]
    fn n07_an_unreadable_settings_file_is_never_overwritten() {
        use std::os::windows::fs::OpenOptionsExt as _;
        let dir = temp_dir("locked");
        let path = dir.join("settings.toml");
        std::fs::write(&path, "[appearance]\nfont_size = 20\n").unwrap();
        let holder = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .unwrap();
        let service = SettingsService::in_dir(&dir);
        drop(holder);
        let mut settings = service.settings();
        settings.terminal.default_profile = "cmd".into();
        let error = service.save(settings).unwrap_err();
        assert_eq!(error.kind, ErrorKind::Unavailable);
        assert!(error.message.contains("settings.toml"), "{}", error.message);
        assert_eq!(service.default_profile().as_deref(), Some("cmd"));
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "[appearance]\nfont_size = 20\n"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A damaged file is copied aside at start and stays until the first save replaces it.
    #[test]
    fn n07_a_damaged_settings_file_is_kept_until_a_save() {
        let dir = temp_dir("damaged");
        let path = dir.join("settings.toml");
        std::fs::write(&path, "not = [toml").unwrap();
        let service = SettingsService::in_dir(&dir);
        assert_eq!(service.settings(), Settings::default());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "not = [toml");
        let names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("settings.broken-"))
            .collect();
        assert_eq!(names.len(), 1);
        assert_eq!(
            std::fs::read_to_string(dir.join(&names[0])).unwrap(),
            "not = [toml"
        );
        service.save(Settings::default()).unwrap();
        assert_eq!(
            SettingsFile::in_dir(&dir).load().settings,
            Settings::default()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
