//! Which console host our shells run in.

/// The console host behind ConPTY sessions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConsoleHost {
    /// Microsoft's newer ConPTY shipped next to our executable (`conpty.dll` + `OpenConsole.exe`).
    Bundled,
    /// The ConPTY built into Windows (slower; behavior varies by Windows build).
    Inbox,
}

/// `portable-pty` side-loads `conpty.dll` from the executable's directory when it is there.
pub fn console_host() -> ConsoleHost {
    let bundled = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(std::path::Path::to_path_buf))
        .is_some_and(|dir| {
            dir.join("conpty.dll").is_file() && dir.join("OpenConsole.exe").is_file()
        });
    if bundled {
        ConsoleHost::Bundled
    } else {
        ConsoleHost::Inbox
    }
}

#[cfg(test)]
mod tests {
    use std::fmt::Write as _;
    use std::path::Path;

    use sha2::{Digest, Sha256};

    use super::*;

    fn vendored() -> &'static Path {
        Path::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../resources/conpty"
        ))
    }

    #[test]
    fn adr0008_vendored_conpty_matches_its_checksums() {
        let sums = std::fs::read_to_string(vendored().join("SHA256SUMS")).unwrap();
        let mut checked = 0;
        for line in sums.lines().filter(|l| !l.trim().is_empty()) {
            let (expected, file) = line.split_once("  ").expect("`<sha256>  <path>` lines");
            let bytes = std::fs::read(vendored().join(file)).unwrap();
            let actual = Sha256::digest(&bytes)
                .iter()
                .fold(String::new(), |mut hex, byte| {
                    let _ = write!(hex, "{byte:02x}");
                    hex
                });
            assert_eq!(actual, expected, "{file} does not match SHA256SUMS");
            checked += 1;
        }
        assert_eq!(checked, 4, "x64 and arm64, conpty.dll and OpenConsole.exe");
    }

    #[cfg(all(windows, target_arch = "x86_64"))]
    #[test]
    fn adr0008_tests_run_with_the_bundled_console_host() {
        // build.rs copies the files next to test executables too.
        assert_eq!(console_host(), ConsoleHost::Bundled);
    }
}
