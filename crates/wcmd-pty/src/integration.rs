//! Shell integration. Built-in shells are started so that they report their folder
//! (OSC 7 / OSC 9;9) and prompt and command marks (OSC 133) without any user setup.
//!
//! Scripts live in `resources/shell-integration/` and are embedded in the binary. Injection
//! never edits the user's files and always wraps (never replaces) their prompt. WSL
//! distros start their own shell (bash, zsh or fish) through a small `sh` launcher.

use std::path::{Path, PathBuf};

use crate::profiles::Profile;

/// Which integration a profile's shell gets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellKind {
    /// PowerShell 7 and Windows PowerShell 5.1.
    PowerShell,
    Cmd,
    /// Git for Windows' bash.
    Bash,
    /// A WSL distribution; the launcher picks bash, zsh or fish inside it.
    Wsl,
}

const POWERSHELL_SCRIPT: &str = include_str!("../../../resources/shell-integration/wolfcmd.ps1");
const BASH_SCRIPT: &str = include_str!("../../../resources/shell-integration/wolfcmd.bash");
const BASH_SCRIPT_FILE: &str = "wolfcmd.bash";
const ZSH_SCRIPT: &str = include_str!("../../../resources/shell-integration/wolfcmd.zsh");
const FISH_SCRIPT: &str = include_str!("../../../resources/shell-integration/wolfcmd.fish");

/// Zsh has no `--init-file`, so it is started with `ZDOTDIR` pointing at `zsh/`. These
/// shims run the user's own startup files first (from `$WOLFCMD_USER_ZDOTDIR`, `$HOME` when
/// unset), then `wolfcmd.zsh`, then give `ZDOTDIR` back. `.zlogin` needs no shim: by then
/// `ZDOTDIR` is the user's again.
const ZSH_SHIMS: [(&str, &str); 3] = [
    (
        "zsh/.zshenv",
        concat!(
            "# WolfCmd: runs the user's .zshenv, then keeps ZDOTDIR on this folder.\n",
            "__wolfcmd_shim=$ZDOTDIR\n",
            "ZDOTDIR=${WOLFCMD_USER_ZDOTDIR:-$HOME}\n",
            "[ -r \"$ZDOTDIR/.zshenv\" ] && . \"$ZDOTDIR/.zshenv\"\n",
            "WOLFCMD_USER_ZDOTDIR=$ZDOTDIR\n",
            "ZDOTDIR=$__wolfcmd_shim\n",
            "unset __wolfcmd_shim\n",
        ),
    ),
    (
        "zsh/.zprofile",
        concat!(
            "# WolfCmd: the user's own .zprofile.\n",
            "[ -r \"${WOLFCMD_USER_ZDOTDIR:-$HOME}/.zprofile\" ] && ",
            ". \"${WOLFCMD_USER_ZDOTDIR:-$HOME}/.zprofile\"\n",
        ),
    ),
    (
        "zsh/.zshrc",
        concat!(
            "# WolfCmd: the user's own .zshrc, then the integration, then ZDOTDIR is the user's.\n",
            "[ -r \"${WOLFCMD_USER_ZDOTDIR:-$HOME}/.zshrc\" ] && ",
            ". \"${WOLFCMD_USER_ZDOTDIR:-$HOME}/.zshrc\"\n",
            "[ -r \"$WOLFCMD_SCRIPTS/wolfcmd.zsh\" ] && . \"$WOLFCMD_SCRIPTS/wolfcmd.zsh\"\n",
            "ZDOTDIR=${WOLFCMD_USER_ZDOTDIR:-$HOME}\n",
        ),
    ),
];

/// Runs inside the distro (`wsl.exe -d <name> --exec sh -c <this>`), as one line. It
/// picks the distro's login shell (`$SHELL`, else the passwd entry, else bash) and starts it as
/// a login shell, like `wsl.exe -d <name>` does, with WolfCmd's integration for bash, zsh and
/// fish. Any other shell, or missing script files, start unchanged. `$WOLFCMD_SCRIPTS` is the
/// script folder; WSL translates it to a Linux path (`WSLENV` flag `/p`).
const WSL_LAUNCHER: &str = concat!(
    "s=${SHELL:-}; ",
    "[ -x \"$s\" ] || s=$(getent passwd $(id -un) 2>/dev/null | cut -d: -f7); ",
    "[ -x \"$s\" ] || s=$(command -v bash); ",
    "[ -x \"$s\" ] || s=/bin/sh; ",
    "d=$WOLFCMD_SCRIPTS; ",
    "case ${s##*/} in ",
    "bash) [ -r \"$d/wolfcmd.bash\" ] && { WOLFCMD_BASH_LOGIN=1; export WOLFCMD_BASH_LOGIN; ",
    "exec \"$s\" --rcfile \"$d/wolfcmd.bash\" -i; };; ",
    "zsh) [ -r \"$d/zsh/.zshrc\" ] && { WOLFCMD_USER_ZDOTDIR=$ZDOTDIR; ZDOTDIR=$d/zsh; ",
    "export WOLFCMD_USER_ZDOTDIR ZDOTDIR; exec \"$s\" -l -i; };; ",
    "fish) [ -r \"$d/wolfcmd.fish\" ] && exec \"$s\" -l -C \"source '$d/wolfcmd.fish'\";; ",
    "esac; ",
    "exec \"$s\" -l"
);

/// Set to `1` in every integrated shell. Set to `0` in WolfCmd's own environment to turn
/// injection off (the escape hatch until the config system has a setting).
pub const SHELL_INTEGRATION_ENV: &str = "WOLFCMD_SHELL_INTEGRATION";

/// How to start shells with integration.
#[derive(Debug, Clone, Default)]
pub struct ShellIntegration {
    enabled: bool,
    /// Where the scripts were written; bash and WSL start without integration if `None`.
    script_dir: Option<PathBuf>,
}

impl ShellIntegration {
    /// No injection at all.
    pub fn disabled() -> Self {
        Self::default()
    }

    /// Writes the script files to `dir` (only when their content changed) and enables
    /// injection, unless `WOLFCMD_SHELL_INTEGRATION=0`. A write failure only disables bash and WSL.
    pub fn install(dir: &Path) -> Self {
        if std::env::var(SHELL_INTEGRATION_ENV).is_ok_and(|v| v == "0") {
            tracing::info!("shell integration turned off ({SHELL_INTEGRATION_ENV}=0)");
            return Self::disabled();
        }
        let mut files = [
            (BASH_SCRIPT_FILE, BASH_SCRIPT),
            ("wolfcmd.zsh", ZSH_SCRIPT),
            ("wolfcmd.fish", FISH_SCRIPT),
        ]
        .into_iter()
        .chain(ZSH_SHIMS);
        let written =
            files.try_for_each(|(name, content)| write_if_changed(&dir.join(name), content));
        let script_dir = match written {
            Ok(()) => Some(dir.to_path_buf()),
            Err(error) => {
                tracing::warn!(%error, dir = %dir.display(), "bash and WSL shell integration unavailable");
                None
            }
        };
        Self {
            enabled: true,
            script_dir,
        }
    }

    /// `profile` rewritten to start its shell with integration. Profiles without a known
    /// shell (the launch program) are returned unchanged.
    pub fn apply(&self, profile: &Profile) -> Profile {
        let mut launch = profile.clone();
        if !self.enabled {
            return launch;
        }
        match profile.shell {
            None => return launch,
            Some(ShellKind::PowerShell) => {
                launch.args.extend([
                    "-NoExit".to_owned(),
                    "-EncodedCommand".to_owned(),
                    encode_powershell(POWERSHELL_SCRIPT),
                ]);
            }
            Some(ShellKind::Cmd) => {
                let user = std::env::var("PROMPT").ok();
                launch
                    .env
                    .push(("PROMPT".to_owned(), cmd_prompt(user.as_deref())));
            }
            Some(ShellKind::Bash) => {
                let Some(dir) = &self.script_dir else {
                    return launch;
                };
                let script = dir.join(BASH_SCRIPT_FILE);
                let login = profile.args.iter().any(|a| a == "--login" || a == "-l");
                // Cygwin accepts Windows paths; forward slashes avoid escaping questions.
                let script = script.to_string_lossy().replace('\\', "/");
                launch.args = vec!["--init-file".to_owned(), script, "-i".to_owned()];
                if login {
                    launch
                        .env
                        .push(("WOLFCMD_BASH_LOGIN".to_owned(), "1".to_owned()));
                }
                // Git's /etc/profile keeps the start folder only with this set.
                launch
                    .env
                    .push(("CHERE_INVOKING".to_owned(), "1".to_owned()));
            }
            Some(ShellKind::Wsl) => {
                let Some(dir) = &self.script_dir else {
                    return launch;
                };
                let Some(wsl) =
                    wsl_launch(&profile.args, dir, std::env::var("WSLENV").ok().as_deref())
                else {
                    return launch;
                };
                launch.args = wsl.args;
                launch.env.extend(wsl.env);
            }
        }
        launch
            .env
            .push((SHELL_INTEGRATION_ENV.to_owned(), "1".to_owned()));
        launch
    }
}

/// How a WSL profile starts with integration.
#[derive(Debug, PartialEq, Eq)]
struct WslLaunch {
    args: Vec<String>,
    env: Vec<(String, String)>,
}

/// `wsl.exe -d <distro>` becomes `wsl.exe -d <distro> --exec sh -c <launcher>`. The script
/// folder reaches the distro as `$WOLFCMD_SCRIPTS`: `WSLENV` with the `/p` flag makes WSL
/// translate the Windows path itself (`/mnt/c/...`, or wherever the drive is mounted), so no
/// mount root is guessed here. The user's own `WSLENV` is kept. `None` when the profile
/// already runs a command (`--exec`, `-e`, `--`), which is left exactly as given.
fn wsl_launch(args: &[String], script_dir: &Path, user_wslenv: Option<&str>) -> Option<WslLaunch> {
    if args
        .iter()
        .any(|a| matches!(a.as_str(), "-e" | "--exec" | "--"))
    {
        return None;
    }
    let mut wslenv = format!("WOLFCMD_SCRIPTS/p:{SHELL_INTEGRATION_ENV}");
    if let Some(user) = user_wslenv.filter(|v| !v.is_empty()) {
        wslenv.push(':');
        wslenv.push_str(user);
    }
    let mut args = args.to_vec();
    args.extend([
        "--exec".to_owned(),
        "sh".to_owned(),
        "-c".to_owned(),
        WSL_LAUNCHER.to_owned(),
    ]);
    Some(WslLaunch {
        args,
        env: vec![
            (
                "WOLFCMD_SCRIPTS".to_owned(),
                script_dir.to_string_lossy().into_owned(),
            ),
            ("WSLENV".to_owned(), wslenv),
        ],
    })
}

/// cmd can't run a hook, but its `PROMPT` can emit escape sequences (`$e` is ESC, `$P` the
/// folder). It can't URL-encode, so the folder goes out as `OSC 9;9`.
fn cmd_prompt(user: Option<&str>) -> String {
    let user = user.filter(|p| !p.is_empty()).unwrap_or("$P$G");
    if user.contains("133;A") {
        // Already integrated (WolfCmd started from an integrated cmd).
        return user.to_owned();
    }
    format!("$e]9;9;$P$e\\$e]133;A$e\\{user}$e]133;B$e\\")
}

/// `-EncodedCommand` takes base64 of UTF-16LE. Comment and blank lines are dropped to keep
/// the command line short (it is limited to 32767 characters).
fn encode_powershell(script: &str) -> String {
    let code: String = script
        .lines()
        .filter(|line| {
            let line = line.trim();
            !line.is_empty() && !line.starts_with('#')
        })
        .collect::<Vec<_>>()
        .join("\n");
    let bytes: Vec<u8> = code.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64(&bytes)
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(char::from(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// Writes through a temporary file and a rename, so a shell never reads a half-written script.
fn write_if_changed(path: &Path, content: &str) -> std::io::Result<()> {
    // Bash rejects CRLF line endings; the checkout should already be LF (.gitattributes).
    let content = content.replace("\r\n", "\n");
    if std::fs::read_to_string(path).is_ok_and(|existing| existing == content) {
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // Flushed before the move, so a power cut never leaves an empty script.
    wcmd_config::fs::write_atomic(path, content.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(shell: Option<ShellKind>, args: &[&str]) -> Profile {
        Profile {
            id: "p".into(),
            name: "P".into(),
            program: "shell.exe".into(),
            args: args.iter().map(|a| (*a).to_owned()).collect(),
            icon: "terminal".into(),
            shell,
            env: Vec::new(),
        }
    }

    fn enabled(dir: Option<&str>) -> ShellIntegration {
        ShellIntegration {
            enabled: true,
            script_dir: dir.map(PathBuf::from),
        }
    }

    fn env<'a>(p: &'a Profile, key: &str) -> Option<&'a str> {
        p.env
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    #[test]
    fn base64_matches_known_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn powershell_gets_the_script_as_an_encoded_command() {
        let launch = enabled(None).apply(&profile(Some(ShellKind::PowerShell), &["-NoLogo"]));
        assert_eq!(launch.args[..3], ["-NoLogo", "-NoExit", "-EncodedCommand"]);
        // "if" in UTF-16LE base64 starts the script (comments were dropped).
        assert!(launch.args[3].starts_with(&base64(&[b'i', 0, b'f', 0])[..3]));
        assert!(launch.args[3].len() < 16_000, "fits on a command line");
        assert_eq!(env(&launch, SHELL_INTEGRATION_ENV), Some("1"));
    }

    #[test]
    fn powershell_script_is_ascii() {
        // It is sent as UTF-16; non-ASCII would also be a hint of an editor accident.
        assert!(POWERSHELL_SCRIPT.is_ascii());
        assert!(BASH_SCRIPT.is_ascii());
        assert!(!BASH_SCRIPT.contains('\r'), "bash needs LF line endings");
    }

    #[test]
    fn scripts_are_ascii_with_lf_endings() {
        for script in [ZSH_SCRIPT, FISH_SCRIPT, WSL_LAUNCHER] {
            assert!(script.is_ascii());
            assert!(!script.contains('\r'), "Linux shells need LF line endings");
        }
        for (name, content) in ZSH_SHIMS {
            assert!(content.is_ascii(), "{name}");
            assert!(!content.contains('\r'), "{name}");
        }
        assert!(
            !WSL_LAUNCHER.contains('\n'),
            "one line on the wsl.exe command line"
        );
    }

    #[test]
    fn scripts_emit_the_same_marks_as_bash() {
        for (name, script) in [
            ("bash", BASH_SCRIPT),
            ("zsh", ZSH_SCRIPT),
            ("fish", FISH_SCRIPT),
        ] {
            for mark in ["]133;A", "]133;B", "]133;C", "]133;D", "]7;file://"] {
                assert!(script.contains(mark), "{name} reports {mark}");
            }
        }
    }

    const SCRIPTS: &str = r"C:\Users\me\AppData\Local\WolfCmd\shell-integration";

    fn wsl_profile(args: &[&str]) -> Profile {
        let mut p = profile(Some(ShellKind::Wsl), args);
        p.program = r"C:\Windows\System32\wsl.exe".into();
        p
    }

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|a| (*a).to_owned()).collect()
    }

    #[test]
    fn wsl_runs_the_launcher_with_the_script_folder_translated_by_wslenv() {
        let launch = enabled(Some(SCRIPTS)).apply(&wsl_profile(&["-d", "Ubuntu 24.04"]));
        assert_eq!(
            launch.args[..5],
            ["-d", "Ubuntu 24.04", "--exec", "sh", "-c"]
        );
        assert_eq!(launch.args[5], WSL_LAUNCHER);
        assert_eq!(launch.args.len(), 6);
        // The Windows path goes in as is; WSL turns it into a Linux path (/p).
        assert_eq!(env(&launch, "WOLFCMD_SCRIPTS"), Some(SCRIPTS));
        assert!(env(&launch, "WSLENV").is_some_and(|v| v.starts_with("WOLFCMD_SCRIPTS/p:")));
        assert_eq!(env(&launch, SHELL_INTEGRATION_ENV), Some("1"));
    }

    #[test]
    fn wsl_keeps_the_users_wslenv() {
        let args = strings(&["-d", "Debian"]);
        let launch = wsl_launch(&args, Path::new(SCRIPTS), Some("FOO/u:BAR")).unwrap();
        assert_eq!(
            launch.env[1],
            (
                "WSLENV".to_owned(),
                "WOLFCMD_SCRIPTS/p:WOLFCMD_SHELL_INTEGRATION:FOO/u:BAR".to_owned()
            )
        );
        let empty = wsl_launch(&args, Path::new(SCRIPTS), Some("")).unwrap();
        assert_eq!(
            empty.env[1].1,
            "WOLFCMD_SCRIPTS/p:WOLFCMD_SHELL_INTEGRATION"
        );
    }

    #[test]
    fn launcher_builds_the_command_line_per_shell() {
        // bash: login emulation and our rcfile; zsh: the ZDOTDIR shims; fish: an init command.
        assert!(WSL_LAUNCHER.contains(r#"exec "$s" --rcfile "$d/wolfcmd.bash" -i"#));
        assert!(WSL_LAUNCHER.contains("WOLFCMD_BASH_LOGIN=1"));
        assert!(WSL_LAUNCHER.contains("ZDOTDIR=$d/zsh"));
        assert!(WSL_LAUNCHER.contains(r#"exec "$s" -l -i"#));
        assert!(WSL_LAUNCHER.contains(r#"exec "$s" -l -C "source '$d/wolfcmd.fish'""#));
        // The distro's own shell: $SHELL, else its passwd entry, else bash.
        assert!(WSL_LAUNCHER.starts_with("s=${SHELL:-}; "));
        assert!(WSL_LAUNCHER.contains("getent passwd"));
        assert!(WSL_LAUNCHER.contains("command -v bash"));
        // Any other shell, or a missing script, is a plain login shell.
        assert!(WSL_LAUNCHER.ends_with(r#"exec "$s" -l"#));
    }

    #[test]
    fn zsh_shims_read_the_users_files_first() {
        let shim = |name: &str| ZSH_SHIMS.iter().find(|(n, _)| *n == name).unwrap().1;
        assert!(shim("zsh/.zshenv").contains(r#". "$ZDOTDIR/.zshenv""#));
        assert!(shim("zsh/.zprofile").contains("/.zprofile"));
        let zshrc = shim("zsh/.zshrc");
        let user = zshrc.find("/.zshrc").unwrap();
        let ours = zshrc.find("wolfcmd.zsh").unwrap();
        let restore = zshrc.rfind("ZDOTDIR=").unwrap();
        assert!(
            user < ours && ours < restore,
            "user's rc, hooks, ZDOTDIR back"
        );
    }

    #[test]
    fn wsl_profiles_with_a_command_or_without_scripts_are_unchanged() {
        let own = wsl_profile(&["-d", "Ubuntu", "--exec", "htop"]);
        assert_eq!(enabled(Some(SCRIPTS)).apply(&own), own);
        let separated = wsl_profile(&["-d", "Ubuntu", "--", "ls"]);
        assert_eq!(enabled(Some(SCRIPTS)).apply(&separated), separated);
        let plain = wsl_profile(&["-d", "Ubuntu"]);
        assert_eq!(enabled(None).apply(&plain), plain);
        assert_eq!(ShellIntegration::disabled().apply(&plain), plain);
    }

    #[test]
    fn cmd_wraps_the_user_prompt() {
        assert_eq!(
            cmd_prompt(None),
            "$e]9;9;$P$e\\$e]133;A$e\\$P$G$e]133;B$e\\"
        );
        assert_eq!(
            cmd_prompt(Some("[$T] $P$G")),
            "$e]9;9;$P$e\\$e]133;A$e\\[$T] $P$G$e]133;B$e\\"
        );
        let integrated = cmd_prompt(None);
        assert_eq!(cmd_prompt(Some(&integrated)), integrated);
        let launch = enabled(None).apply(&profile(Some(ShellKind::Cmd), &[]));
        assert!(env(&launch, "PROMPT").is_some_and(|p| p.contains("133;A")));
    }

    #[test]
    fn bash_login_shell_uses_the_init_file() {
        let launch = enabled(Some(r"C:\Users\me\AppData\Local\WolfCmd\shell-integration"))
            .apply(&profile(Some(ShellKind::Bash), &["--login", "-i"]));
        assert_eq!(
            launch.args,
            [
                "--init-file",
                "C:/Users/me/AppData/Local/WolfCmd/shell-integration/wolfcmd.bash",
                "-i"
            ]
        );
        assert_eq!(env(&launch, "WOLFCMD_BASH_LOGIN"), Some("1"));
        assert_eq!(env(&launch, "CHERE_INVOKING"), Some("1"));
    }

    #[test]
    fn unknown_shells_disabled_or_missing_script_are_unchanged() {
        let plain = profile(None, &["-x"]);
        assert_eq!(enabled(Some("d")).apply(&plain), plain);
        let pwsh = profile(Some(ShellKind::PowerShell), &[]);
        assert_eq!(ShellIntegration::disabled().apply(&pwsh), pwsh);
        let bash = profile(Some(ShellKind::Bash), &["--login", "-i"]);
        assert_eq!(enabled(None).apply(&bash), bash);
    }

    #[test]
    fn install_writes_the_script_once() {
        let dir = std::env::temp_dir().join(format!("wcmd-n02-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let integration = ShellIntegration::install(&dir);
        let path = dir.join(BASH_SCRIPT_FILE);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), BASH_SCRIPT);
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        ShellIntegration::install(&dir);
        assert_eq!(
            std::fs::metadata(&path).unwrap().modified().unwrap(),
            modified
        );
        assert!(integration.script_dir.is_some());
        // The WSL scripts and the zsh shims are written too.
        assert_eq!(
            std::fs::read_to_string(dir.join("wolfcmd.zsh")).unwrap(),
            ZSH_SCRIPT
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("wolfcmd.fish")).unwrap(),
            FISH_SCRIPT
        );
        for (name, content) in ZSH_SHIMS {
            assert_eq!(std::fs::read_to_string(dir.join(name)).unwrap(), content);
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
