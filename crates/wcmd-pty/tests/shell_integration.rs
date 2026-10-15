//! Real shells, started with integration, report their folder and command marks.
//! A shell that isn't installed is skipped (Git Bash on CI machines without Git).
#![cfg(windows)]

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use wcmd_pty::{Profile, PtySession, PtySize, PtyWriter, ShellIntegration, installed_profiles};

const TIMEOUT: Duration = Duration::from_secs(30);

fn spawn_reader(mut reader: Box<dyn Read + Send>) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                break;
            }
        }
    });
    rx
}

/// Output so far, collected until `needle` appears; answers ConPTY's cursor query like
/// xterm.js does in the app.
struct Session {
    rx: mpsc::Receiver<Vec<u8>>,
    writer: PtyWriter,
    output: String,
    _console: PtySession,
}

impl Session {
    fn wait_for(&mut self, needle: &str) -> usize {
        self.wait_for_any(&[needle]).0
    }

    /// Waits until one of `needles` appears; returns where, and which.
    fn wait_for_any<'a>(&mut self, needles: &[&'a str]) -> (usize, &'a str) {
        let deadline = Instant::now() + TIMEOUT;
        loop {
            if let Some(found) = needles
                .iter()
                .find_map(|needle| self.output.find(needle).map(|at| (at, *needle)))
            {
                return found;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            let chunk = self.rx.recv_timeout(left).unwrap_or_else(|_| {
                panic!("timed out waiting for {needles:?}; got {:?}", self.output)
            });
            let text = String::from_utf8_lossy(&chunk);
            if text.contains("\x1b[6n") {
                self.writer
                    .write(b"\x1b[1;1R")
                    .expect("answering the cursor query");
            }
            self.output.push_str(&text);
        }
    }

    fn type_line(&mut self, line: &str) {
        self.writer
            .write(format!("{line}\r").as_bytes())
            .expect("typing");
    }
}

/// A fresh folder with a space and a percent sign, to check how paths are encoded. Its full
/// path: a temp folder named in 8.3 form (`C:\Users\RUNNER~1\…` on CI machines) is expanded,
/// as the shells report the full name.
fn work_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("wcmd n02 100% {name} {}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("creating the test folder");
    let full = std::fs::canonicalize(&dir).expect("the test folder's full path");
    // `canonicalize` gives a verbatim path (`\\?\C:\…`); shells report the plain form.
    let plain = full
        .to_string_lossy()
        .trim_start_matches(r"\\?\")
        .to_owned();
    PathBuf::from(plain)
}

fn start(id: &str, dir: &Path) -> Option<Session> {
    // Not installed here (Git Bash on a machine without Git): nothing to test.
    let profile = installed_profiles().iter().find(|p| p.id == id).cloned()?;
    let scripts = dir.join("scripts");
    let launch: Profile = ShellIntegration::install(&scripts).apply(&profile);
    let spawned = PtySession::spawn(
        &launch,
        PtySize {
            cols: 120,
            rows: 30,
        },
        Some(dir),
    )
    .expect("spawning");
    Some(Session {
        rx: spawn_reader(spawned.reader),
        writer: spawned.writer,
        output: String::new(),
        _console: spawned.session,
    })
}

/// `C:\Users\me\x y` as an OSC 7 URL path: `C:/Users/me/x%20y`.
fn url_path(dir: &Path) -> String {
    dir.to_string_lossy()
        .replace('\\', "/")
        .replace('%', "%25")
        .replace(' ', "%20")
}

#[test]
fn windows_powershell_reports_folder_and_command_marks() {
    let dir = work_dir("powershell");
    let Some(mut shell) = start("windows-powershell", &dir) else {
        return;
    };
    shell.wait_for(&format!("/{}\x07", url_path(&dir)));
    shell.wait_for("\x1b]133;B\x07");
    // The user's (here: the default) prompt is still printed between A and B.
    let a = shell.wait_for("\x1b]133;A\x07");
    assert!(
        shell.output[a..].contains("PS "),
        "prompt kept: {:?}",
        shell.output
    );

    shell.type_line("cmd /c exit 3");
    let c = shell.wait_for("\x1b]133;C\x07");
    let d = shell.wait_for("\x1b]133;D;3\x07");
    assert!(c < d, "command start before command end");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn cmd_reports_folder_and_prompt_marks() {
    let dir = work_dir("cmd");
    let Some(mut shell) = start("cmd", &dir) else {
        return;
    };
    shell.wait_for(&format!("\x1b]9;9;{}\x1b\\", dir.to_string_lossy()));
    shell.wait_for("\x1b]133;A\x1b\\");
    shell.wait_for("\x1b]133;B\x1b\\");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn git_bash_reports_folder_and_command_marks() {
    let dir = work_dir("bash");
    let Some(mut shell) = start("git-bash", &dir) else {
        return;
    };
    // The folder arrives as a Windows path, not /c/Users/….
    shell.wait_for(&format!("/{}\x07", url_path(&dir)));
    shell.wait_for("\x1b]133;B\x07");
    shell.type_line("(exit 3)");
    let c = shell.wait_for("\x1b]133;C\x07");
    let d = shell.wait_for("\x1b]133;D;3\x07");
    assert!(c < d, "command start before command end");
    // Login shell semantics: /etc/profile ran (Git sets MSYSTEM there). Git for Windows starts
    // in one of its standard environments (MINGW64 by default, UCRT64 or CLANG64 on some
    // installs); the typed line itself shows only `$MSYSTEM`.
    shell.type_line("echo \"msystem=$MSYSTEM\"");
    shell.wait_for_any(&[
        "msystem=MINGW64",
        "msystem=UCRT64",
        "msystem=CLANG64",
        "msystem=CLANGARM64",
        "msystem=MINGW32",
    ]);
    let _ = std::fs::remove_dir_all(&dir);
}
