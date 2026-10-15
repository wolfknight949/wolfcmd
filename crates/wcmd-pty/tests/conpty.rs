//! Real ConPTY sessions (Windows only).
#![cfg(windows)]

use std::io::Read;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use wcmd_pty::{Profile, PtySession, PtySize, PtyWriter};

const TIMEOUT: Duration = Duration::from_secs(20);

/// `/v:on` enables delayed expansion (`!v!`), so variables are read when the command runs.
fn cmd(script: &str) -> Profile {
    Profile {
        id: "cmd".into(),
        icon: "terminal".into(),
        name: "cmd".into(),
        program: "cmd.exe".into(),
        args: vec!["/v:on".into(), "/d".into(), "/c".into(), script.into()],
        ..Profile::default()
    }
}

/// Reads output on a thread (as the app does) and forwards it in chunks.
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

/// Collects output until `needle` appears, answering ConPTY's cursor-position query the
/// way xterm.js does in the app.
fn wait_for(rx: &mpsc::Receiver<Vec<u8>>, writer: &mut PtyWriter, needle: &str) -> String {
    let deadline = Instant::now() + TIMEOUT;
    let mut output = String::new();
    while !output.contains(needle) {
        let left = deadline.saturating_duration_since(Instant::now());
        let chunk = rx
            .recv_timeout(left)
            .unwrap_or_else(|_| panic!("timed out waiting for {needle:?}; got {output:?}"));
        let text = String::from_utf8_lossy(&chunk);
        if text.contains("\x1b[6n") {
            writer
                .write(b"\x1b[1;1R")
                .expect("answering the cursor query");
        }
        output.push_str(&text);
    }
    output
}

#[test]
fn shell_output_reaches_the_reader() {
    let spawned = PtySession::spawn(
        &cmd("echo wolfcmd-n02"),
        PtySize { cols: 80, rows: 24 },
        None,
    )
    .unwrap();
    let mut writer = spawned.writer;
    let rx = spawn_reader(spawned.reader);
    wait_for(&rx, &mut writer, "wolfcmd-n02");
}

#[test]
fn input_reaches_the_shell_and_exit_is_reported() {
    let spawned = PtySession::spawn(
        &cmd("set /p v= & echo got-!v! & exit /b 7"),
        PtySize { cols: 80, rows: 24 },
        None,
    )
    .unwrap();
    let mut writer = spawned.writer;
    let mut child = spawned.child;
    let rx = spawn_reader(spawned.reader);

    writer.write(b"wolf\r\n").unwrap();
    wait_for(&rx, &mut writer, "got-wolf");

    let status = child.wait().unwrap();
    assert_eq!(status.exit_code(), 7);
}

#[test]
fn resize_succeeds_on_a_live_session() {
    let spawned =
        PtySession::spawn(&cmd("pause >nul"), PtySize { cols: 80, rows: 24 }, None).unwrap();
    let mut session = spawned.session;
    session
        .resize(PtySize {
            cols: 120,
            rows: 40,
        })
        .unwrap();
    session.kill();
}

/// The attention, progress and clipboard sequences agents emit pass through ConPTY
/// to the renderer (which acts on them).
#[test]
fn osc_9_777_52_and_bel_pass_through() {
    let script = "$e=[char]27; $b=[char]7; Write-Host -NoNewline ($e+']9;Agent needs input'+$b+$e+']9;4;1;50'+$b+$e+']777;notify;Title;Body'+$b+$e+']52;c;aGk='+$b+$b+' done-n02')";
    let powershell = Profile {
        program: "powershell.exe".into(),
        args: vec!["-NoProfile".into(), "-Command".into(), script.into()],
        ..Profile::default()
    };
    let spawned = PtySession::spawn(
        &powershell,
        PtySize {
            cols: 120,
            rows: 24,
        },
        None,
    )
    .unwrap();
    let mut writer = spawned.writer;
    let rx = spawn_reader(spawned.reader);
    let output = wait_for(&rx, &mut writer, "done-n02");
    for needle in [
        "\x1b]9;Agent needs input\x07",
        "\x1b]9;4;1;50\x07",
        "\x1b]777;notify;Title;Body\x07",
        "\x1b]52;c;aGk=\x07",
    ] {
        assert!(
            output.contains(needle),
            "{needle:?} missing from {output:?}"
        );
    }
}
