//! Built-in profile providers. Each one only checks files, environment variables and
//! the registry (no processes), so discovery stays fast.

use std::path::{Path, PathBuf};

use super::{Environment, Hive, Profile};
use crate::integration::ShellKind;

const ICON: &str = "terminal";

fn profile(
    id: &str,
    name: &str,
    program: &Path,
    args: &[&str],
    shell: Option<ShellKind>,
) -> Profile {
    Profile {
        id: id.to_owned(),
        name: name.to_owned(),
        program: program.to_string_lossy().into_owned(),
        args: args.iter().map(|a| (*a).to_owned()).collect(),
        icon: ICON.to_owned(),
        shell,
        env: Vec::new(),
    }
}

fn first_existing(
    env: &dyn Environment,
    candidates: impl IntoIterator<Item = Option<PathBuf>>,
) -> Option<PathBuf> {
    candidates.into_iter().flatten().find(|p| env.exists(p))
}

fn system_root(env: &dyn Environment) -> PathBuf {
    PathBuf::from(
        env.var("SystemRoot")
            .unwrap_or_else(|| r"C:\Windows".to_owned()),
    )
}

/// PowerShell 7+ (`pwsh.exe`).
pub(super) fn powershell_core(env: &dyn Environment) -> Option<Profile> {
    let program = env.on_path("pwsh.exe").or_else(|| {
        first_existing(
            env,
            [env.var("ProgramFiles")
                .map(|p| PathBuf::from(p).join(r"PowerShell\7\pwsh.exe"))],
        )
    })?;
    Some(profile(
        "pwsh",
        "PowerShell",
        &program,
        &["-NoLogo"],
        Some(ShellKind::PowerShell),
    ))
}

/// Windows PowerShell 5.1, built into Windows.
pub(super) fn windows_powershell(env: &dyn Environment) -> Option<Profile> {
    let program = first_existing(
        env,
        [Some(
            system_root(env).join(r"System32\WindowsPowerShell\v1.0\powershell.exe"),
        )],
    )
    .or_else(|| env.on_path("powershell.exe"))?;
    Some(profile(
        "windows-powershell",
        "Windows PowerShell",
        &program,
        &["-NoLogo"],
        Some(ShellKind::PowerShell),
    ))
}

pub(super) fn command_prompt(env: &dyn Environment) -> Option<Profile> {
    let program = first_existing(env, [env.var("ComSpec").map(PathBuf::from)])
        .or_else(|| env.on_path("cmd.exe"))?;
    Some(profile(
        "cmd",
        "Command Prompt",
        &program,
        &[],
        Some(ShellKind::Cmd),
    ))
}

/// Git for Windows' bash, as a login shell.
pub(super) fn git_bash(env: &dyn Environment) -> Option<Profile> {
    let install = env.registry_string(Hive::LocalMachine, r"SOFTWARE\GitForWindows", "InstallPath");
    let program = first_existing(
        env,
        [
            install.map(|p| PathBuf::from(p).join(r"bin\bash.exe")),
            env.var("ProgramFiles")
                .map(|p| PathBuf::from(p).join(r"Git\bin\bash.exe")),
            env.var("LOCALAPPDATA")
                .map(|p| PathBuf::from(p).join(r"Programs\Git\bin\bash.exe")),
        ],
    )?;
    Some(profile(
        "git-bash",
        "Git Bash",
        &program,
        &["--login", "-i"],
        Some(ShellKind::Bash),
    ))
}

const LXSS: &str = r"Software\Microsoft\Windows\CurrentVersion\Lxss";

/// Every installed WSL distribution, the default one first. Read from the registry, so
/// discovery doesn't start the WSL VM.
pub(super) fn wsl(env: &dyn Environment) -> Vec<Profile> {
    let wsl = system_root(env).join(r"System32\wsl.exe");
    if !env.exists(&wsl) {
        return Vec::new();
    }
    let default = env.registry_string(Hive::CurrentUser, LXSS, "DefaultDistribution");
    let mut distros: Vec<(bool, String)> = env
        .registry_subkeys(Hive::CurrentUser, LXSS)
        .into_iter()
        .filter_map(|guid| {
            let name = env.registry_string(
                Hive::CurrentUser,
                &format!(r"{LXSS}\{guid}"),
                "DistributionName",
            )?;
            // Docker Desktop's internal distros aren't shells people want to open.
            (!name.starts_with("docker-desktop"))
                .then(|| (default.as_deref() == Some(guid.as_str()), name))
        })
        .collect();
    distros.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    distros
        .into_iter()
        .map(|(_, name)| {
            let id = format!("wsl.{}", normalize(&name));
            // The distro's own shell starts with WolfCmd's integration.
            profile(&id, &name, &wsl, &["-d", &name], Some(ShellKind::Wsl))
        })
        .collect()
}

/// `SSH: <host>` for every concrete `Host` in `~/.ssh/config` (`ssh <host>`), when an
/// OpenSSH client is installed. Read at discovery (a file read, no process); the config is
/// not re-read until WolfCmd restarts. No shell integration runs on the remote side.
pub(super) fn ssh(env: &dyn Environment) -> Vec<Profile> {
    let Some(ssh) = first_existing(
        env,
        [Some(system_root(env).join(r"System32\OpenSSH\ssh.exe"))],
    )
    .or_else(|| env.on_path("ssh.exe")) else {
        return Vec::new();
    };
    let Some(home) = env.var("USERPROFILE").or_else(|| env.var("HOME")) else {
        return Vec::new();
    };
    let config = PathBuf::from(home).join(".ssh").join("config");
    let Some(config) = env.read_to_string(&config) else {
        return Vec::new();
    };
    ssh_hosts(&config)
        .into_iter()
        .map(|host| {
            let id = format!("ssh.{}", normalize(&host));
            profile(&id, &format!("SSH: {host}"), &ssh, &[&host], None)
        })
        .collect()
}

/// The concrete host names in an OpenSSH client config, in file order, without duplicates.
/// A `Host` line lists patterns: wildcards (`*`, `?`) and negations (`!`) are not hosts you
/// can connect to by name, so they are skipped, as are names starting with `-` (they would be
/// read as an `ssh` option). Comments, `Match` blocks and `Include` lines are ignored (an
/// include's own hosts don't show up), and keywords are case-insensitive, with `Host=name`
/// and quoted names accepted.
fn ssh_hosts(config: &str) -> Vec<String> {
    let mut hosts: Vec<String> = Vec::new();
    for line in config.lines() {
        let line = line.trim();
        let Some(keyword) = line.get(..4) else {
            continue;
        };
        if !keyword.eq_ignore_ascii_case("host") {
            continue;
        }
        // `Host` must end at a space, a tab or `=` (not `HostName`, `HostKeyAlgorithms`).
        let rest = &line[4..];
        if !rest.starts_with([' ', '\t', '=']) {
            continue;
        }
        for pattern in rest.trim_start_matches([' ', '\t', '=']).split_whitespace() {
            // A trailing comment ends the list.
            if pattern.starts_with('#') {
                break;
            }
            let host = pattern.trim_matches('"');
            let skip = host.is_empty() || host.starts_with(['-', '!']) || host.contains(['*', '?']);
            if !skip && !hosts.iter().any(|h| h == host) {
                hosts.push(host.to_owned());
            }
        }
    }
    hosts
}

/// Profile IDs are lowercase with no spaces: `Ubuntu 24.04` → `ubuntu-24.04`.
fn normalize(name: &str) -> String {
    name.trim()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};

    use super::*;
    use crate::profiles::discover_in;

    /// A machine described by its files, variables, PATH and registry.
    #[derive(Default)]
    struct Fake {
        vars: HashMap<String, String>,
        files: HashSet<PathBuf>,
        path: HashMap<String, PathBuf>,
        contents: HashMap<PathBuf, String>,
        strings: HashMap<(String, String), String>,
        subkeys: HashMap<String, Vec<String>>,
    }

    impl Fake {
        fn windows() -> Self {
            let mut fake = Self::default();
            fake.set_var("SystemRoot", r"C:\Windows")
                .set_var("ComSpec", r"C:\Windows\system32\cmd.exe");
            fake.set_var("ProgramFiles", r"C:\Program Files")
                .set_var("LOCALAPPDATA", r"C:\Users\u\AppData\Local");
            fake.add_file(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe");
            fake.add_file(r"C:\Windows\system32\cmd.exe");
            fake
        }
        fn set_var(&mut self, k: &str, v: &str) -> &mut Self {
            self.vars.insert(k.into(), v.into());
            self
        }
        fn add_file(&mut self, p: &str) -> &mut Self {
            self.files.insert(PathBuf::from(p));
            self
        }
        fn set_reg(&mut self, key: &str, value: &str, data: &str) -> &mut Self {
            self.strings.insert((key.into(), value.into()), data.into());
            self
        }
    }

    impl Environment for Fake {
        fn var(&self, name: &str) -> Option<String> {
            self.vars.get(name).cloned()
        }
        fn exists(&self, path: &Path) -> bool {
            self.files.contains(path)
        }
        fn on_path(&self, exe: &str) -> Option<PathBuf> {
            self.path.get(exe).cloned()
        }
        fn read_to_string(&self, path: &Path) -> Option<String> {
            self.contents.get(path).cloned()
        }
        fn registry_string(&self, _hive: Hive, key: &str, value: &str) -> Option<String> {
            self.strings
                .get(&(key.to_owned(), value.to_owned()))
                .cloned()
        }
        fn registry_subkeys(&self, _hive: Hive, key: &str) -> Vec<String> {
            self.subkeys.get(key).cloned().unwrap_or_default()
        }
    }

    fn ids(env: &Fake) -> Vec<String> {
        discover_in(env).into_iter().map(|p| p.id).collect()
    }

    #[test]
    fn plain_windows_has_windows_powershell_and_cmd() {
        assert_eq!(ids(&Fake::windows()), ["windows-powershell", "cmd"]);
    }

    #[test]
    fn powershell_7_comes_first_from_program_files_or_path() {
        let mut env = Fake::windows();
        env.add_file(r"C:\Program Files\PowerShell\7\pwsh.exe");
        let profiles = discover_in(&env);
        assert_eq!(profiles[0].id, "pwsh");
        assert_eq!(
            profiles[0].program,
            r"C:\Program Files\PowerShell\7\pwsh.exe"
        );

        let mut env = Fake::windows();
        env.path
            .insert("pwsh.exe".into(), PathBuf::from(r"D:\tools\pwsh.exe"));
        assert_eq!(discover_in(&env)[0].program, r"D:\tools\pwsh.exe");
    }

    #[test]
    fn git_bash_from_the_registry_install_path() {
        let mut env = Fake::windows();
        env.set_reg(r"SOFTWARE\GitForWindows", "InstallPath", r"E:\Git")
            .add_file(r"E:\Git\bin\bash.exe");
        let bash = discover_in(&env)
            .into_iter()
            .find(|p| p.id == "git-bash")
            .unwrap();
        assert_eq!(bash.program, r"E:\Git\bin\bash.exe");
        assert_eq!(bash.args, ["--login", "-i"]);
    }

    #[test]
    fn wsl_distros_default_first_without_docker_internals() {
        let mut env = Fake::windows();
        env.add_file(r"C:\Windows\System32\wsl.exe");
        env.subkeys
            .insert(LXSS.into(), vec!["{a}".into(), "{b}".into(), "{c}".into()]);
        env.set_reg(LXSS, "DefaultDistribution", "{b}");
        env.set_reg(&format!(r"{LXSS}\{{a}}"), "DistributionName", "Debian");
        env.set_reg(
            &format!(r"{LXSS}\{{b}}"),
            "DistributionName",
            "Ubuntu 24.04",
        );
        env.set_reg(
            &format!(r"{LXSS}\{{c}}"),
            "DistributionName",
            "docker-desktop",
        );
        let wsl: Vec<_> = discover_in(&env)
            .into_iter()
            .filter(|p| p.id.starts_with("wsl."))
            .collect();
        assert_eq!(
            wsl.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            ["wsl.ubuntu-24.04", "wsl.debian"]
        );
        assert_eq!(wsl[0].args, ["-d", "Ubuntu 24.04"]);
        assert_eq!(wsl[0].name, "Ubuntu 24.04");
    }

    #[test]
    fn no_wsl_exe_means_no_wsl_profiles() {
        let mut env = Fake::windows();
        env.subkeys.insert(LXSS.into(), vec!["{a}".into()]);
        env.set_reg(&format!(r"{LXSS}\{{a}}"), "DistributionName", "Debian");
        assert!(!ids(&env).iter().any(|id| id.starts_with("wsl.")));
    }

    #[test]
    fn wsl_profiles_get_wsl_shell_integration() {
        let mut env = Fake::windows();
        env.add_file(r"C:\Windows\System32\wsl.exe");
        env.subkeys.insert(LXSS.into(), vec!["{a}".into()]);
        env.set_reg(&format!(r"{LXSS}\{{a}}"), "DistributionName", "Debian");
        let profiles = discover_in(&env);
        let debian = profiles.iter().find(|p| p.id == "wsl.debian").unwrap();
        assert_eq!(debian.shell, Some(ShellKind::Wsl));
        assert_eq!(debian.args, ["-d", "Debian"]);
    }

    const CONFIG: &str = "
# my hosts
Host dev
    HostName dev.example.com
    User me

host  build   Staging   # staging and the build box
  HostKeyAlgorithms +ssh-rsa

Host *
    ServerAliveInterval 30
Host *.internal git? !secret -oProxyCommand=x
Host=eq
Host \"quoted\" dev
Match host other
    User nobody
Include config.d/*
HostName notahost
";

    #[test]
    fn ssh_hosts_lists_concrete_hosts_in_file_order() {
        assert_eq!(
            ssh_hosts(CONFIG),
            ["dev", "build", "Staging", "eq", "quoted"]
        );
    }

    #[test]
    fn ssh_hosts_skips_wildcards_negations_options_and_other_keywords() {
        assert_eq!(
            ssh_hosts("Host *\nHost a? b*\nHost !x\nHost -oFoo=1").len(),
            0
        );
        // `HostName`, `HostKeyAlgorithms`, comments and `Match` never start a host list.
        assert_eq!(
            ssh_hosts("HostName a\n# Host b\n  HostKeyAlgorithms c\nMatch host d\nHostx e").len(),
            0
        );
        assert_eq!(ssh_hosts("").len(), 0);
    }

    #[test]
    fn ssh_hosts_ignores_include_lines() {
        // Included files aren't followed: only this file's own hosts are listed.
        assert_eq!(ssh_hosts("Include other\nHost a\nInclude b c"), ["a"]);
    }

    #[test]
    fn ssh_profiles_run_ssh_with_the_host() {
        let mut env = Fake::windows();
        env.add_file(r"C:\Windows\System32\OpenSSH\ssh.exe");
        env.set_var("USERPROFILE", r"C:\Users\u");
        env.contents.insert(
            PathBuf::from(r"C:\Users\u\.ssh\config"),
            "Host Dev-Box\n  User me\nHost *\n".into(),
        );
        let profiles = discover_in(&env);
        let ssh = profiles.iter().find(|p| p.id == "ssh.dev-box").unwrap();
        assert_eq!(ssh.name, "SSH: Dev-Box");
        assert_eq!(ssh.program, r"C:\Windows\System32\OpenSSH\ssh.exe");
        assert_eq!(ssh.args, ["Dev-Box"]);
        assert_eq!(ssh.shell, None);
        // They come after the local shells.
        assert_eq!(profiles.last().unwrap().id, "ssh.dev-box");
    }

    #[test]
    fn no_ssh_client_or_no_config_means_no_ssh_profiles() {
        let mut env = Fake::windows();
        env.set_var("USERPROFILE", r"C:\Users\u");
        env.contents
            .insert(PathBuf::from(r"C:\Users\u\.ssh\config"), "Host a\n".into());
        assert!(!ids(&env).iter().any(|id| id.starts_with("ssh.")), "no ssh");
        env.add_file(r"C:\Windows\System32\OpenSSH\ssh.exe");
        env.contents.clear();
        assert!(
            !ids(&env).iter().any(|id| id.starts_with("ssh.")),
            "no config"
        );
    }

    #[test]
    fn ids_are_normalized() {
        assert_eq!(normalize("  Ubuntu  24.04 "), "ubuntu-24.04");
        assert_eq!(normalize("Arch"), "arch");
    }
}
