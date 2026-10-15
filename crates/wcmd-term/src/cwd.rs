//! The shell's current folder, as reported in its output.
//!
//! Shells (or their prompts) announce the folder with an OSC sequence after each command:
//! - `OSC 7 ; file://host/path ST`: the xterm/VTE convention (WSL, Starship, Oh My Posh).
//! - `OSC 9 ; 9 ; "C:\path" ST`: Windows Terminal's (Oh My Posh, pwsh/cmd setups).
//!
//! It also counts the prompts the shell started (`OSC 133 ; A`, shell integration), so the core
//! knows when a command typed at one prompt has ended (N-06: an agent exited).
//!
//! `alacritty_terminal` ignores these, so this small scanner runs next to it. It keeps no
//! more than one sequence of state, so a sequence split across reads is still found.

/// Longer OSC payloads are not folder reports; skip them without buffering.
const MAX_PAYLOAD: usize = 4096;

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;
const CAN: u8 = 0x18;
const SUB: u8 = 0x1a;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Scan {
    Ground,
    Escape,
    Osc,
    /// An ESC inside an OSC: `\` ends it (ST), anything else starts over.
    OscEscape,
    /// An OSC too long to be a folder report; wait for its end.
    Skip,
}

#[derive(Debug)]
pub(crate) struct CwdScanner {
    scan: Scan,
    payload: Vec<u8>,
    latest: Option<String>,
    /// `OSC 133 ; A` marks seen.
    prompts: u64,
}

impl Default for CwdScanner {
    fn default() -> Self {
        Self {
            scan: Scan::Ground,
            payload: Vec::new(),
            latest: None,
            prompts: 0,
        }
    }
}

impl CwdScanner {
    pub(crate) fn feed(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.scan = match (self.scan, byte) {
                (Scan::Osc | Scan::Skip, BEL) | (Scan::OscEscape, b'\\') => {
                    self.finish();
                    Scan::Ground
                }
                (Scan::Ground | Scan::Escape | Scan::OscEscape, ESC) => Scan::Escape,
                (Scan::Escape | Scan::OscEscape, b']') => {
                    self.payload.clear();
                    Scan::Osc
                }
                (Scan::Osc | Scan::Skip, ESC) => Scan::OscEscape,
                (Scan::Osc, _) if self.payload.len() >= MAX_PAYLOAD => Scan::Skip,
                (Scan::Osc | Scan::Skip, CAN | SUB)
                | (Scan::Ground | Scan::Escape | Scan::OscEscape, _) => Scan::Ground,
                (Scan::Osc, _) => {
                    self.payload.push(byte);
                    Scan::Osc
                }
                (Scan::Skip, _) => Scan::Skip,
            };
            if self.scan == Scan::Skip {
                self.payload.clear();
            }
        }
    }

    /// The folder reported since the last call, if any (the latest one wins).
    pub(crate) fn take(&mut self) -> Option<String> {
        self.latest.take()
    }

    /// The prompts the shell started so far (`OSC 133 ; A`).
    pub(crate) fn prompts(&self) -> u64 {
        self.prompts
    }

    fn finish(&mut self) {
        let payload = std::mem::take(&mut self.payload);
        if payload.starts_with(b"133;A") {
            self.prompts += 1;
            return;
        }
        if let Some(cwd) = std::str::from_utf8(&payload).ok().and_then(parse) {
            self.latest = Some(cwd);
        }
    }
}

/// The folder in an OSC payload (without `ESC ]` and the terminator), if it is one.
fn parse(payload: &str) -> Option<String> {
    let path = match (payload.strip_prefix("7;"), payload.strip_prefix("9;9;")) {
        (Some(url), _) => from_file_url(url)?,
        (None, Some(path)) => {
            let path = path.trim();
            path.strip_prefix('"')
                .and_then(|p| p.strip_suffix('"'))
                .unwrap_or(path)
                .to_owned()
        }
        (None, None) => return None,
    };
    let valid = !path.is_empty()
        && path.len() <= 1024
        && !path.chars().any(char::is_control)
        && is_local(&path);
    valid.then_some(path)
}

/// A folder on this machine: a drive path (`C:\x`), a POSIX one (`/home/me`), or a WSL
/// distribution's disk (`\\wsl$\Ubuntu`, `\\wsl.localhost\Ubuntu`). Anything else is refused:
/// a network share (`\\host\share`, `//host/share`) or a device path (`\\?\`, `\\.\`, `\??\`)
/// would make WolfCmd reach another machine (Windows signs in to it with the user's
/// credentials) when it checks the folder of a new or restored terminal, and any program can
/// print a folder report.
fn is_local(path: &str) -> bool {
    let slash = |b: u8| b == b'\\' || b == b'/';
    match path.as_bytes() {
        [letter, b':', rest @ ..] if letter.is_ascii_alphabetic() => {
            rest.first().is_none_or(|&b| slash(b))
        }
        [first, second, ..] if slash(*first) && slash(*second) => {
            let mut parts = path[2..].split(['\\', '/']);
            let host = parts.next().unwrap_or("");
            let share = parts.next().unwrap_or("");
            !share.is_empty()
                && (host.eq_ignore_ascii_case("wsl$") || host.eq_ignore_ascii_case("wsl.localhost"))
        }
        [b'/', ..] => true,
        _ => false,
    }
}

/// `file://host/C:/Users/me` → `C:\Users\me`; `file://host/home/me` → `/home/me`;
/// Git Bash's `file://host/c/Users/me` → `C:\Users\me`.
fn from_file_url(url: &str) -> Option<String> {
    let rest = url.strip_prefix("file://")?;
    let path = percent_decode(&rest[rest.find('/')?..])?;
    let segments: Vec<&str> = path[1..].splitn(2, '/').collect();
    let drive = segments.first().and_then(|first| {
        let bytes = first.as_bytes();
        match bytes {
            [letter, b':'] | [letter] if letter.is_ascii_alphabetic() => {
                Some(letter.to_ascii_uppercase() as char)
            }
            _ => None,
        }
    });
    Some(match drive {
        Some(letter) => {
            let tail = segments.get(1).copied().unwrap_or("").replace('/', "\\");
            format!("{letter}:\\{tail}")
        }
        None => path,
    })
}

fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = text.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scan(chunks: &[&[u8]]) -> Option<String> {
        let mut scanner = CwdScanner::default();
        for chunk in chunks {
            scanner.feed(chunk);
        }
        scanner.take()
    }

    #[test]
    fn osc_cwd_osc7_with_bel_and_st() {
        assert_eq!(
            scan(&[b"\x1b]7;file://pc/C:/Users/me\x07PS> "]).as_deref(),
            Some(r"C:\Users\me")
        );
        assert_eq!(
            scan(&[b"\x1b]7;file://pc/home/me/src\x1b\\$ "]).as_deref(),
            Some("/home/me/src")
        );
    }

    #[test]
    fn osc_cwd_osc9_9_quoted_or_not() {
        assert_eq!(
            scan(&[b"\x1b]9;9;\"C:\\src\\my app\"\x1b\\"]).as_deref(),
            Some(r"C:\src\my app")
        );
        assert_eq!(
            scan(&[b"\x1b]9;9;D:\\work\x07"]).as_deref(),
            Some(r"D:\work")
        );
    }

    #[test]
    fn osc_cwd_split_across_chunks() {
        assert_eq!(
            scan(&[b"out\x1b", b"]7;file:", b"//pc/C:/a%20b", b"\x1b", b"\\"]).as_deref(),
            Some(r"C:\a b")
        );
    }

    #[test]
    fn osc_cwd_git_bash_drive_paths() {
        assert_eq!(
            scan(&[b"\x1b]7;file://pc/c/Users/me\x07"]).as_deref(),
            Some(r"C:\Users\me")
        );
        assert_eq!(scan(&[b"\x1b]7;file://pc/d\x07"]).as_deref(), Some(r"D:\"));
    }

    /// A program can print any folder report: a network share or a device path would make the
    /// core contact another machine (with the user's Windows sign-in) when it checks the folder.
    #[test]
    fn osc_cwd_refuses_folders_on_other_machines() {
        for input in [
            &br"]9;9;\\attacker\share"[..],
            br#"]9;9;"\\attacker@SSL\x""#,
            b"]9;9;//attacker/share",
            b"]7;file://pc//attacker/share",
            b"]7;file://pc/%5C%5Cattacker%5Cshare",
            br"]9;9;\\?\UNC\attacker\share",
            br"]9;9;\??\UNC\attacker\share",
            br"]9;9;\\.\pipe\x",
            br"]9;9;\\wsl$",
            br"]9;9;relative\dir",
        ] {
            let report = [b"\x1b", input, b"\x07"].concat();
            assert_eq!(scan(&[&report]), None, "{}", String::from_utf8_lossy(input));
        }
        // This machine's folders, WSL's disks included.
        for (input, folder) in [
            (
                &br"]9;9;\\wsl.localhost\Ubuntu\home"[..],
                r"\\wsl.localhost\Ubuntu\home",
            ),
            (br"]9;9;\\WSL$\Debian", r"\\WSL$\Debian"),
            (br"]9;9;Z:\mapped", r"Z:\mapped"),
            (b"]7;file://pc/", "/"),
        ] {
            let report = [b"\x1b", input, b"\x07"].concat();
            assert_eq!(scan(&[&report]).as_deref(), Some(folder), "{folder}");
        }
    }

    #[test]
    fn osc_cwd_latest_wins_and_take_clears() {
        let mut scanner = CwdScanner::default();
        scanner.feed(b"\x1b]9;9;C:\\one\x07\x1b]9;9;C:\\two\x07");
        assert_eq!(scanner.take().as_deref(), Some(r"C:\two"));
        assert_eq!(scanner.take(), None);
    }

    #[test]
    fn n06_prompt_marks_are_counted_with_either_terminator_and_split() {
        let mut scanner = CwdScanner::default();
        // PowerShell and bash end with BEL, cmd's PROMPT with ST; B, C and D are not prompts.
        scanner.feed(b"\x1b]133;A\x07PS> \x1b]133;B\x07");
        scanner.feed(b"\x1b]133;C\x07out\x1b]133;D;0\x07\x1b]9;9;C:\\x\x1b\\\x1b]133;A\x1b\\>");
        scanner.feed(b"\x1b]13");
        scanner.feed(b"3;A\x07");
        assert_eq!(scanner.prompts(), 3);
        // Folder reports still come through around them.
        assert_eq!(scanner.take().as_deref(), Some(r"C:\x"));
    }

    #[test]
    fn osc_cwd_ignores_other_sequences_and_garbage() {
        for input in [
            &b"\x1b]0;window title\x07"[..],
            b"\x1b]7;http://example.com/\x07",
            b"\x1b]7;file://pc/bad%zz\x07",
            b"\x1b]9;4;3;50\x07",
            b"\x1b]9;9;\x07",
            b"\x1b]9;9;C:\\a\x18 cancelled\x07",
            b"\x1b[31mred\x1b[0m",
        ] {
            assert_eq!(scan(&[input]), None, "{}", String::from_utf8_lossy(input));
        }
        let long = [b"\x1b]9;9;".as_slice(), &[b'a'; MAX_PAYLOAD + 10], b"\x07"].concat();
        assert_eq!(scan(&[&long]), None);
        // The scanner recovers for the next report.
        assert_eq!(
            scan(&[&long, b"\x1b]9;9;C:\\ok\x07"]).as_deref(),
            Some(r"C:\ok")
        );
    }
}
