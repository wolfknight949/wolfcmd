//! N-09: plugins. A plugin is a folder `<data dir>/plugins/<id>/` with a `plugin.toml`
//! manifest that declares data: its id, name and version, and the agents it contributes, each
//! shaped like a built-in `resources/agents/*.toml`. WolfCmd never runs plugin code: a
//! plugin agent's command is typed into a terminal only when the user opens that agent.
//!
//! Reading is file checks and small file reads only. What can't be used is reported as a
//! [`PluginProblem`] and skipped; the rest loads.

use std::ffi::OsString;
use std::path::Path;
use std::time::SystemTime;

use serde::Deserialize;

use crate::registry::{Agent, parse_agent_value};

/// The manifest every plugin folder has.
pub(crate) const MANIFEST: &str = "plugin.toml";

/// A manifest declares a few agents; a larger file is refused (never read whole).
const MAX_MANIFEST: u64 = 256 * 1024;

/// Something in the plugins folder that couldn't be used: a folder without a manifest, a
/// manifest that doesn't parse, or one agent entry. Reported, never fatal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginProblem {
    /// The plugin's folder name.
    pub plugin: String,
    /// What is wrong, for the user (the TOML parser's own message when it is the cause).
    pub message: String,
}

/// `plugin.toml`. Unknown fields are refused, never half-read (like an agent entry).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    /// Equal to the folder's name.
    id: String,
    name: String,
    version: String,
    /// Shown nowhere yet; allowed so a plugin can say what it is.
    #[serde(default)]
    #[allow(dead_code)]
    description: Option<String>,
    /// `[[agents]]` tables, each read on its own so one bad entry doesn't drop the others.
    #[serde(default)]
    agents: Vec<toml::Value>,
}

/// A plugin whose manifest loaded, with the agent entries that parsed.
#[derive(Debug)]
pub(crate) struct Plugin {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) agents: Vec<Agent>,
}

/// What the plugins folder held at one moment: each folder's name and its manifest's modified
/// time and size (`None`: no manifest). Equal fingerprints mean nothing to read again.
pub(crate) type Fingerprint = Vec<(OsString, Option<(SystemTime, u64)>)>;

/// The folder's fingerprint: one listing and one file check per plugin. A missing folder has
/// no plugins.
pub(crate) fn fingerprint(dir: &Path) -> Fingerprint {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut print: Fingerprint = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .map(|entry| {
            let manifest = std::fs::metadata(entry.path().join(MANIFEST)).ok();
            let stamp = manifest
                .filter(std::fs::Metadata::is_file)
                .and_then(|m| Some((m.modified().ok()?, m.len())));
            (entry.file_name(), stamp)
        })
        .collect();
    print.sort();
    print
}

/// Every plugin of the fingerprint (folder-name order) and what couldn't be used.
pub(crate) fn read_plugins(dir: &Path, print: &Fingerprint) -> (Vec<Plugin>, Vec<PluginProblem>) {
    let mut plugins = Vec::new();
    let mut problems = Vec::new();
    for (folder, stamp) in print {
        let folder = folder.to_string_lossy().into_owned();
        let mut problem = |message: String| {
            problems.push(PluginProblem {
                plugin: folder.clone(),
                message,
            });
        };
        if stamp.is_none() {
            problem(format!("no {MANIFEST} in this folder"));
            continue;
        }
        let text = match read_manifest_file(&dir.join(&folder).join(MANIFEST)) {
            Ok(Some(text)) => text,
            Ok(None) => {
                problem(format!(
                    "{MANIFEST} is larger than {} KiB",
                    MAX_MANIFEST / 1024
                ));
                continue;
            }
            Err(error) => {
                problem(format!("{MANIFEST} can't be read: {error}"));
                continue;
            }
        };
        match read_manifest(&folder, &text) {
            Ok((plugin, entry_problems)) => {
                entry_problems.into_iter().for_each(&mut problem);
                plugins.push(plugin);
            }
            Err(message) => problem(message),
        }
    }
    (plugins, problems)
}

/// The manifest's text; `None` when it is larger than [`MAX_MANIFEST`] (never read whole).
fn read_manifest_file(path: &Path) -> std::io::Result<Option<String>> {
    use std::io::Read as _;
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(MAX_MANIFEST + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_MANIFEST {
        return Ok(None);
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

/// One manifest: the plugin, and a message for each agent entry that was skipped. `Err`: the
/// whole plugin is skipped.
fn read_manifest(folder: &str, text: &str) -> Result<(Plugin, Vec<String>), String> {
    let manifest: Manifest = toml::from_str(text).map_err(|e| format!("{MANIFEST}: {e}"))?;
    if manifest.id != folder {
        return Err(format!(
            "its id `{}` must be the name of its folder (`{folder}`)",
            manifest.id
        ));
    }
    if !valid_id(&manifest.id) {
        return Err(format!("its id `{}` {ID_RULE}", manifest.id));
    }
    if manifest.name.trim().is_empty() || manifest.version.trim().is_empty() {
        return Err("its name and version can't be empty".to_owned());
    }
    let mut agents = Vec::new();
    let mut skipped = Vec::new();
    for (index, value) in manifest.agents.into_iter().enumerate() {
        let label = value.get("id").and_then(toml::Value::as_str).map_or_else(
            || format!("agent #{}", index + 1),
            |id| format!("agent `{id}`"),
        );
        match parse_agent_value(value).and_then(|agent| check_agent(&agent).map(|()| agent)) {
            Ok(agent) => agents.push(agent),
            Err(message) => skipped.push(format!("{label}: {message}")),
        }
    }
    Ok((
        Plugin {
            id: manifest.id,
            name: manifest.name,
            agents,
        },
        skipped,
    ))
}

const ID_RULE: &str = "can only have lowercase letters, digits and `-` (at most 64)";

/// Plugin and agent ids: lowercase ASCII letters, digits and `-`, not starting with `-`,
/// 1 to 64 characters (a folder name on every OS, a word in a log line).
pub(crate) fn valid_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && !id.starts_with('-')
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// What a built-in's tests check, for a plugin agent at load time.
fn check_agent(agent: &Agent) -> Result<(), String> {
    if !valid_id(&agent.id) {
        return Err(format!("the id {ID_RULE}"));
    }
    if agent.name.trim().is_empty() || agent.command.trim().is_empty() {
        return Err("`name` and `command` can't be empty".to_owned());
    }
    if agent.detect.iter().all(|exe| exe.trim().is_empty()) {
        return Err("`detect` needs the name of its program".to_owned());
    }
    if !(1..=8).contains(&agent.color) {
        return Err("`color` is 1 to 8".to_owned());
    }
    if let Some(pattern) = &agent.working_title {
        crate::registry::TitlePattern::new(pattern)
            .map_err(|error| format!("`working_title` is not a valid regex: {error}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn n09_the_guides_example_loads() {
        let guide = include_str!("../../../docs/guides/plugins.md");
        let example = guide
            .split("```toml")
            .nth(1)
            .and_then(|rest| rest.split("```").next())
            .unwrap();
        let (plugin, skipped) = read_manifest("my-tools", example).unwrap();
        assert_eq!(skipped, Vec::<String>::new());
        assert_eq!(plugin.agents.len(), 1);
        assert_eq!(plugin.agents[0].id, "mycli");
    }

    /// N-09: a huge or deeply nested manifest is a problem, never a huge read or a crash.
    #[test]
    fn n09_oversized_and_nested_manifests_are_problems() {
        let dir = std::env::temp_dir().join(format!("wcmd n09 bomb {}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for name in ["huge", "nested"] {
            std::fs::create_dir_all(dir.join(name)).unwrap();
        }
        let huge = format!(
            "id = \"huge\"
# {}
",
            "x".repeat(300 * 1024)
        );
        std::fs::write(dir.join("huge").join(MANIFEST), huge).unwrap();
        let depth = 100_000;
        let nested = format!(
            "x = {}{}
",
            "[".repeat(depth),
            "]".repeat(depth)
        );
        std::fs::write(dir.join("nested").join(MANIFEST), nested).unwrap();
        let (plugins, problems) = read_plugins(&dir, &fingerprint(&dir));
        assert!(plugins.is_empty());
        assert_eq!(problems.len(), 2, "{problems:?}");
        assert!(
            problems[0].message.contains("larger than 256 KiB"),
            "{problems:?}"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn n09_ids_are_folder_names() {
        for id in ["a", "my-tools", "x2", &"a".repeat(64)] {
            assert!(valid_id(id), "{id}");
        }
        for id in ["", "-a", "A", "a_b", "a b", "a.b", "é", &"a".repeat(65)] {
            assert!(!valid_id(id), "{id}");
        }
    }
}
