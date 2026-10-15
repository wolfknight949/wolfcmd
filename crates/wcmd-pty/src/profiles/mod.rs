//! Shell profiles: what to run in a terminal, and which shells this machine has.

mod providers;

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::integration::ShellKind;

/// What to run in a terminal.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Profile {
    /// Stable, lowercase: `pwsh`, `windows-powershell`, `cmd`, `git-bash`, `wsl.<distro>`,
    /// `ssh.<host>`.
    pub id: String,
    /// Shown to the user, e.g. "PowerShell".
    pub name: String,
    pub program: String,
    pub args: Vec<String>,
    /// A ui-kit glyph name.
    pub icon: String,
    /// Which shell integration it gets; `None` runs it exactly as given.
    pub shell: Option<ShellKind>,
    /// Extra environment for the shell (set by shell integration).
    pub env: Vec<(String, String)>,
}

/// Registry hive, for providers that read the registry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Hive {
    CurrentUser,
    LocalMachine,
}

/// What providers may look at. Real lookups in production, a fake in tests.
pub(crate) trait Environment {
    fn var(&self, name: &str) -> Option<String>;
    fn exists(&self, path: &Path) -> bool;
    fn on_path(&self, exe: &str) -> Option<PathBuf>;
    /// A small text file (`~/.ssh/config`); `None` when missing or not UTF-8.
    fn read_to_string(&self, path: &Path) -> Option<String>;
    fn registry_string(&self, hive: Hive, key: &str, value: &str) -> Option<String>;
    fn registry_subkeys(&self, hive: Hive, key: &str) -> Vec<String>;
}

struct RealEnvironment;

impl Environment for RealEnvironment {
    fn var(&self, name: &str) -> Option<String> {
        std::env::var(name).ok().filter(|v| !v.is_empty())
    }
    fn exists(&self, path: &Path) -> bool {
        path.is_file()
    }
    fn on_path(&self, exe: &str) -> Option<PathBuf> {
        which::which(exe).ok()
    }
    fn read_to_string(&self, path: &Path) -> Option<String> {
        std::fs::read_to_string(path).ok()
    }
    fn registry_string(&self, hive: Hive, key: &str, value: &str) -> Option<String> {
        crate::platform::registry_string(hive, key, value)
    }
    fn registry_subkeys(&self, hive: Hive, key: &str) -> Vec<String> {
        crate::platform::registry_subkeys(hive, key)
    }
}

/// Every built-in provider, in display order. Extensions will add providers (registry).
pub(crate) fn discover_in(env: &dyn Environment) -> Vec<Profile> {
    let mut profiles = Vec::new();
    profiles.extend(providers::powershell_core(env));
    profiles.extend(providers::windows_powershell(env));
    profiles.extend(providers::command_prompt(env));
    profiles.extend(providers::git_bash(env));
    profiles.extend(providers::wsl(env));
    profiles.extend(providers::ssh(env));
    profiles
}

/// The shells installed on this machine, discovered once per run (registry and file checks
/// only, well under 50 ms) and cached.
pub fn installed_profiles() -> &'static [Profile] {
    static PROFILES: OnceLock<Vec<Profile>> = OnceLock::new();
    PROFILES.get_or_init(|| {
        let start = std::time::Instant::now();
        let profiles = discover_in(&RealEnvironment);
        tracing::info!(
            count = profiles.len(),
            ms = start.elapsed().as_secs_f64() * 1000.0,
            "shell profiles discovered"
        );
        profiles
    })
}

/// Names the default shell by profile ID (`cmd`, `pwsh`, ...) for one run. The end-to-end
/// tests (`tests/e2e`) use it for a shell they control.
pub const DEFAULT_PROFILE_ENV: &str = "WOLFCMD_DEFAULT_PROFILE";

/// N-07: the default shell with the user's choice (`terminal.default_profile`): the
/// environment's (`WOLFCMD_DEFAULT_PROFILE`) first, then `preferred` when it is installed,
/// then the first installed one.
pub fn default_profile_preferring(preferred: Option<&str>) -> Profile {
    let env = std::env::var(DEFAULT_PROFILE_ENV).ok();
    choose_default(installed_profiles(), env.as_deref(), preferred).unwrap_or_else(|| Profile {
        id: "cmd".into(),
        name: "Command Prompt".into(),
        program: "cmd.exe".into(),
        args: Vec::new(),
        icon: "terminal".into(),
        shell: Some(ShellKind::Cmd),
        env: Vec::new(),
    })
}

/// Pure: the first of `env`, `preferred` and the first installed profile that is installed.
fn choose_default(
    installed: &[Profile],
    env: Option<&str>,
    preferred: Option<&str>,
) -> Option<Profile> {
    let find = |id: &str| installed.iter().find(|p| p.id == id.trim());
    env.and_then(find)
        .or_else(|| preferred.and_then(find))
        .or_else(|| installed.first())
        .cloned()
}

/// An installed profile by ID.
pub fn find_profile(id: &str) -> Option<Profile> {
    installed_profiles().iter().find(|p| p.id == id).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn installed(ids: &[&str]) -> Vec<Profile> {
        ids.iter()
            .map(|id| Profile {
                id: (*id).to_owned(),
                ..Profile::default()
            })
            .collect()
    }

    fn chosen(env: Option<&str>, preferred: Option<&str>) -> Option<String> {
        choose_default(&installed(&["pwsh", "cmd", "git-bash"]), env, preferred).map(|p| p.id)
    }

    #[test]
    fn n07_the_environment_then_the_setting_then_the_first_installed() {
        assert_eq!(chosen(None, None).as_deref(), Some("pwsh"));
        assert_eq!(chosen(None, Some("git-bash")).as_deref(), Some("git-bash"));
        // The e2e tests' `WOLFCMD_DEFAULT_PROFILE` wins over the setting.
        assert_eq!(
            chosen(Some("cmd"), Some("git-bash")).as_deref(),
            Some("cmd")
        );
        // A choice that isn't installed (any more) is skipped.
        assert_eq!(chosen(Some("nope"), Some("gone")).as_deref(), Some("pwsh"));
        assert_eq!(chosen(None, Some("")).as_deref(), Some("pwsh"));
        assert_eq!(choose_default(&[], None, Some("cmd")), None);
    }
}
