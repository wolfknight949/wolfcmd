//! Finds an agent's executable where installers really put it, not only on PATH:
//! winget packages and links, the native installers, npm/pnpm/bun/scoop/Volta shims, and the
//! copies bundled with desktop apps and editor extensions. File checks and folder listings
//! only (never a process spawn), so it runs on every launch.

use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;

/// Where an agent's executable was found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Location {
    /// On PATH: typed by name.
    OnPath,
    /// Elsewhere: typed by its full path.
    File(PathBuf),
}

/// The shell an agent is typed into: how a full path is quoted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchShell {
    /// PowerShell 7 and Windows PowerShell: `& 'C:\…\codex.cmd' resume --last`.
    PowerShell,
    /// Command Prompt: `"C:\…\codex.cmd" resume --last`.
    Cmd,
    /// Git Bash: `'C:/…/codex' resume --last`.
    Bash,
    /// WSL or a custom program: Windows paths mean nothing there; typed by name.
    Other,
}

/// Folders where package managers put command shims; checked for every agent's `detect`
/// names with these extensions.
const COMMON_DIRS: &[&str] = &[
    r"%LOCALAPPDATA%\Microsoft\WinGet\Links",
    r"%USERPROFILE%\.local\bin",
    r"%APPDATA%\npm",
    r"%PNPM_HOME%",
    r"%LOCALAPPDATA%\pnpm",
    r"%USERPROFILE%\.bun\bin",
    r"%USERPROFILE%\scoop\shims",
    r"%LOCALAPPDATA%\Volta\bin",
    r"%NVM_SYMLINK%",
];
const EXTENSIONS: &[&str] = &["exe", "cmd"];

/// What detection may look at: the real environment in production, fakes in tests.
pub(crate) struct Probe<'a> {
    pub(crate) var: &'a dyn Fn(&str) -> Option<String>,
    pub(crate) on_path: &'a dyn Fn(&str) -> bool,
}

/// PATH first, then the common shim folders, then the agent's own `locations`
/// (`%VAR%` expanded, `*` matches within one folder name; the newest match wins).
pub(crate) fn locate(
    detect: &[String],
    locations: &[String],
    probe: &Probe<'_>,
) -> Option<Location> {
    if detect.iter().any(|exe| (probe.on_path)(exe)) {
        return Some(Location::OnPath);
    }
    for dir in COMMON_DIRS.iter().filter_map(|dir| expand(dir, probe.var)) {
        for exe in detect {
            for ext in EXTENSIONS {
                let file = Path::new(&dir).join(format!("{exe}.{ext}"));
                if file.is_file() {
                    return Some(Location::File(file));
                }
            }
        }
    }
    locations
        .iter()
        .filter_map(|pattern| expand(pattern, probe.var))
        .find_map(|pattern| newest_match(Path::new(&pattern)))
        .map(Location::File)
}

/// The real environment.
pub(crate) fn locate_here(detect: &[String], locations: &[String]) -> Option<Location> {
    let var = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
    let on_path = |exe: &str| which::which(exe).is_ok();
    locate(
        detect,
        locations,
        &Probe {
            var: &var,
            on_path: &on_path,
        },
    )
}

/// `command` (start or resume) with its program replaced by `path`, quoted for `shell`.
pub(crate) fn with_program(command: &str, path: &Path, shell: LaunchShell) -> String {
    let rest = command.split_once(' ').map_or("", |(_, rest)| rest);
    let program = match shell {
        LaunchShell::PowerShell => {
            format!("& '{}'", path.to_string_lossy().replace('\'', "''"))
        }
        LaunchShell::Cmd => format!("\"{}\"", path.to_string_lossy()),
        LaunchShell::Bash => {
            // npm puts a shell script without extension next to its `.cmd` shim.
            let script = path.with_extension("");
            let path = if path
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("cmd"))
                && script.is_file()
            {
                script
            } else {
                path.to_path_buf()
            };
            let text = path.to_string_lossy().replace('\\', "/");
            format!("'{}'", text.replace('\'', r"'\''"))
        }
        LaunchShell::Other => return command.to_owned(),
    };
    if rest.is_empty() {
        program
    } else {
        format!("{program} {rest}")
    }
}

/// `%NAME%` replaced by the variable; `None` when one is unset (the location doesn't apply).
fn expand(pattern: &str, var: &dyn Fn(&str) -> Option<String>) -> Option<String> {
    let mut out = String::new();
    let mut rest = pattern;
    while let Some(start) = rest.find('%') {
        let end = rest[start + 1..].find('%')? + start + 1;
        out.push_str(&rest[..start]);
        out.push_str(&var(&rest[start + 1..end])?);
        rest = &rest[end + 1..];
    }
    out.push_str(rest);
    Some(out)
}

/// The most recently modified file matching `pattern` (`*` within folder or file names).
fn newest_match(pattern: &Path) -> Option<PathBuf> {
    let mut candidates = vec![PathBuf::new()];
    for component in pattern.components() {
        let Component::Normal(name) = component else {
            for candidate in &mut candidates {
                candidate.push(component.as_os_str());
            }
            continue;
        };
        let name = name.to_string_lossy();
        if name.contains('*') {
            candidates = candidates
                .iter()
                .filter_map(|dir| std::fs::read_dir(dir).ok())
                .flat_map(|entries| entries.filter_map(Result::ok))
                .filter(|entry| wildcard(&name, &entry.file_name().to_string_lossy()))
                .map(|entry| entry.path())
                .collect();
        } else {
            for candidate in &mut candidates {
                candidate.push(name.as_ref());
            }
        }
        if candidates.is_empty() {
            return None;
        }
    }
    candidates
        .into_iter()
        .filter(|path| path.is_file())
        .max_by_key(|path| {
            path.metadata()
                .and_then(|m| m.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH)
        })
}

/// Case-insensitive match where `*` is any run of characters (Windows file names).
fn wildcard(pattern: &str, name: &str) -> bool {
    let pattern = pattern.to_lowercase();
    let name = name.to_lowercase();
    let mut parts = pattern.split('*');
    let first = parts.next().unwrap_or_default();
    let Some(mut tail) = name.strip_prefix(first) else {
        return false;
    };
    let rest: Vec<&str> = parts.collect();
    let Some((last, middle)) = rest.split_last() else {
        return tail.is_empty();
    };
    for part in middle {
        match tail.find(part) {
            Some(at) => tail = &tail[at + part.len()..],
            None => return false,
        }
    }
    tail.ends_with(last)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh temp folder for one test.
    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("locate_{name}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn touch(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "").unwrap();
    }

    fn strings(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    fn probe_in<'a>(
        var: &'a dyn Fn(&str) -> Option<String>,
        on_path: &'a dyn Fn(&str) -> bool,
    ) -> Probe<'a> {
        Probe { var, on_path }
    }

    #[test]
    fn path_wins_then_shims_then_the_agents_own_locations() {
        let root = temp("order");
        let local = root.join("Local");
        let roaming = root.join("Roaming");
        let var = |name: &str| match name {
            "LOCALAPPDATA" => Some(local.to_string_lossy().into_owned()),
            "APPDATA" => Some(roaming.to_string_lossy().into_owned()),
            _ => None, // USERPROFILE, PNPM_HOME… unset: those folders are skipped
        };
        let nowhere = |_: &str| false;
        let detect = strings(&["claude"]);
        let locations = strings(&[
            r"%LOCALAPPDATA%\Microsoft\WinGet\Packages\Anthropic.ClaudeCode_*\claude.exe",
        ]);

        assert_eq!(locate(&detect, &locations, &probe_in(&var, &nowhere)), None);

        // winget's package folder (a common install: not on PATH).
        let package = local
            .join(r"Microsoft\WinGet\Packages\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe\claude.exe");
        touch(&package);
        assert_eq!(
            locate(&detect, &locations, &probe_in(&var, &nowhere)),
            Some(Location::File(package))
        );

        // An npm shim comes before the agent's own locations.
        let shim = roaming.join(r"npm\claude.cmd");
        touch(&shim);
        assert_eq!(
            locate(&detect, &locations, &probe_in(&var, &nowhere)),
            Some(Location::File(shim))
        );

        // PATH beats everything: typed by name.
        let everywhere = |_: &str| true;
        assert_eq!(
            locate(&detect, &locations, &probe_in(&var, &everywhere)),
            Some(Location::OnPath)
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn wildcards_pick_the_newest_match_in_nested_folders() {
        let root = temp("newest");
        let var = |name: &str| (name == "USERPROFILE").then(|| root.to_string_lossy().into_owned());
        let nowhere = |_: &str| false;
        let old = root
            .join(r".vscode\extensions\openai.chatgpt-1.0-win32-x64\bin\windows-x86_64\codex.exe");
        let new = root
            .join(r".vscode\extensions\openai.chatgpt-2.0-win32-x64\bin\windows-x86_64\codex.exe");
        touch(&old);
        std::thread::sleep(std::time::Duration::from_millis(20));
        touch(&new);
        touch(&root.join(r".vscode\extensions\other.ext-1.0\bin\windows-x86_64\codex.exe"));
        let found = locate(
            &strings(&["codex"]),
            &strings(&[
                r"%USERPROFILE%\.vscode\extensions\OpenAI.ChatGPT-*\bin\windows-x86_64\codex.exe",
            ]),
            &probe_in(&var, &nowhere),
        );
        assert_eq!(found, Some(Location::File(new)));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn wildcard_and_expansion_rules() {
        assert!(wildcard(
            "Anthropic.ClaudeCode_*",
            "anthropic.claudecode_microsoft"
        ));
        assert!(wildcard("a*b*c", "a-x-b-y-c"));
        assert!(wildcard("*", "anything"));
        assert!(!wildcard("a*c", "ab"));
        assert!(!wildcard("abc", "abcd"));
        let var = |name: &str| (name == "A").then(|| "x".to_owned());
        assert_eq!(expand(r"%A%\b", &var).as_deref(), Some(r"x\b"));
        assert_eq!(expand(r"%B%\b", &var), None);
        assert_eq!(expand(r"plain", &var).as_deref(), Some("plain"));
    }

    #[test]
    fn full_paths_are_quoted_for_each_shell() {
        let exe = Path::new(r"C:\Program Files\It's\claude.exe");
        assert_eq!(
            with_program("claude --resume abc", exe, LaunchShell::PowerShell),
            r"& 'C:\Program Files\It''s\claude.exe' --resume abc"
        );
        assert_eq!(
            with_program("claude", exe, LaunchShell::Cmd),
            r#""C:\Program Files\It's\claude.exe""#
        );
        assert_eq!(
            with_program("claude --continue", exe, LaunchShell::Bash),
            r"'C:/Program Files/It'\''s/claude.exe' --continue"
        );
        assert_eq!(
            with_program("claude --continue", exe, LaunchShell::Other),
            "claude --continue"
        );
    }

    #[test]
    fn bash_uses_npms_shell_script_next_to_the_cmd_shim() {
        let root = temp("bash");
        let shim = root.join("codex.cmd");
        touch(&shim);
        let quoted = |path: &Path| format!("'{}'", path.to_string_lossy().replace('\\', "/"));
        assert_eq!(
            with_program("codex", &shim, LaunchShell::Bash),
            quoted(&shim)
        );
        touch(&root.join("codex"));
        assert_eq!(
            with_program("codex", &shim, LaunchShell::Bash),
            quoted(&root.join("codex"))
        );
        let _ = std::fs::remove_dir_all(root);
    }
}
