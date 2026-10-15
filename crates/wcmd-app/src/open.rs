//! N-02: what a Ctrl+clicked terminal link opens. Pure decisions
//! here (tested); `ipc::app::app_open_link` carries them out through `crate::platform`.
//!
//! - URLs (`http`, `https`, `mailto`) open in the default browser or mail app; other schemes
//!   are refused.
//! - Files open in VS Code at `line:column` when `code` is on PATH, else in their default app.
//!   Documents and media an editor can't show (PDF, video, audio…) always use their default app.
//! - Executables and scripts are **never run** from a link: the file manager shows them
//!   instead (by extension on every OS, and by the executable bit on macOS and Linux). On
//!   Windows the type is read as Windows reads it (trailing dots and spaces dropped), and a
//!   name with an alternate data stream (`x.exe::$DATA`) is refused.
//! - Network shares and device paths (`\\host\share`, `//host/share`, `\\?\`, `file://host/…`)
//!   are refused before the disk is touched: checking one would sign in to that machine.
//! - Folders open in the file manager. Paths that don't exist (or relative ones without the
//!   terminal's folder) are an error.

use std::path::{Path, PathBuf};

/// Extensions a link must never execute (an OS runs these on "open").
const EXECUTABLE: &[&str] = &[
    // Windows
    "exe",
    "com",
    "bat",
    "cmd",
    "ps1",
    "psm1",
    "vbs",
    "vbe",
    "js",
    "jse",
    "wsf",
    "wsh",
    "msi",
    "msp",
    "scr",
    "lnk",
    "pif",
    "cpl",
    "hta",
    "jar",
    "reg",
    "inf",
    "url",
    "appref-ms",
    "msc",
    "py",
    "pyw",
    "pyz",
    "pyzw",
    "pyc",
    // Windows: install, mount or run code when opened
    "application",
    "appx",
    "appxbundle",
    "msix",
    "msixbundle",
    "cab",
    "chm",
    "diagcab",
    "iso",
    "img",
    "vhd",
    "vhdx",
    "jnlp",
    "scf",
    "sct",
    "settingcontent-ms",
    "website",
    "wsc",
    "xbap",
    "xll",
    // Windows: run a program, install, or connect to another machine with the user's sign-in
    "appinstaller",
    "deskthemepack",
    "gadget",
    "library-ms",
    "msu",
    "ps1xml",
    "psc1",
    "psd1",
    "rdp",
    "search-ms",
    "searchconnector-ms",
    "shb",
    "shs",
    "theme",
    "themepack",
    "vb",
    "vsto",
    "ws",
    "wsb",
    // macOS and Linux
    "sh",
    "bash",
    "zsh",
    "fish",
    "command",
    "tool",
    "app",
    "workflow",
    "scpt",
    "applescript",
    "terminal",
    "desktop",
    "appimage",
    "run",
];

const URL_SCHEMES: &[&str] = &["http", "https", "mailto"];

/// Documents and media an editor can't show open in their default app (a PDF reader, a
/// player), even when VS Code is there.
const DEFAULT_APP: &[&str] = &[
    "pdf", "mp4", "webm", "mov", "mkv", "avi", "m4v", "mp3", "wav", "ogg", "flac", "m4a", "aac",
    "docx", "xlsx", "pptx", "psd", "blend", "fbx", "aseprite", "ase",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum OpenAction {
    Url(String),
    /// Open in VS Code at a position (`code --goto path:line:col`).
    Editor {
        path: PathBuf,
        line: u32,
        column: u32,
    },
    /// The file's default app, or the file manager for a folder.
    Default(PathBuf),
    /// Show (select) it in the file manager; never run it.
    Reveal(PathBuf),
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub(crate) enum OpenError {
    #[error("only http, https and mailto links can be opened")]
    Scheme,
    #[error("{0} does not exist")]
    Missing(String),
    /// A network share or device path: opening (even checking) it would reach another machine.
    #[error("links to network or device paths are not opened")]
    Remote,
}

/// File-system checks, faked in tests.
pub(crate) trait Fs {
    fn exists(&self, path: &Path) -> bool;
    fn is_dir(&self, path: &Path) -> bool;
    /// The OS would run it as a program (the executable bit; never on Windows).
    fn is_executable(&self, path: &Path) -> bool;
}

pub(crate) struct RealFs;

impl Fs for RealFs {
    fn exists(&self, path: &Path) -> bool {
        path.exists()
    }
    fn is_dir(&self, path: &Path) -> bool {
        path.is_dir()
    }
    fn is_executable(&self, path: &Path) -> bool {
        crate::platform::is_executable_file(path)
    }
}

/// Decides what to do with a clicked `target` (a URL or a path, relative to `cwd`).
/// `has_editor` says whether `code` is on PATH.
pub(crate) fn plan(
    target: &str,
    line: Option<u32>,
    column: Option<u32>,
    cwd: Option<&Path>,
    fs: &dyn Fs,
    has_editor: bool,
) -> Result<OpenAction, OpenError> {
    if target.chars().any(char::is_control) {
        return Err(OpenError::Scheme);
    }
    if let Some(scheme) = url_scheme(target) {
        if URL_SCHEMES.contains(&scheme.to_ascii_lowercase().as_str()) {
            return Ok(OpenAction::Url(target.to_owned()));
        }
        if !scheme.eq_ignore_ascii_case("file") {
            return Err(OpenError::Scheme);
        }
    }
    let raw = link_path(target).ok_or(OpenError::Remote)?;
    // Checked before the disk is touched: even `exists` on `\\host\share` signs in to the host.
    if is_remote(raw) {
        return Err(OpenError::Remote);
    }
    let path = resolve(raw, cwd);
    if !path.is_absolute() {
        return Err(OpenError::Missing(path.display().to_string()));
    }
    if cfg!(windows) && has_stream(&path) {
        return Err(OpenError::Scheme);
    }
    if !fs.exists(&path) {
        return Err(OpenError::Missing(path.display().to_string()));
    }
    if fs.is_dir(&path) {
        return Ok(OpenAction::Default(path));
    }
    let extension = file_type(&path);
    let has = |list: &[&str]| extension.as_deref().is_some_and(|e| list.contains(&e));
    if has(EXECUTABLE) || fs.is_executable(&path) {
        return Ok(OpenAction::Reveal(path));
    }
    if has_editor && !has(DEFAULT_APP) {
        return Ok(OpenAction::Editor {
            path,
            line: line.unwrap_or(1).max(1),
            column: column.unwrap_or(1).max(1),
        });
    }
    Ok(OpenAction::Default(path))
}

/// `https://…` → `https`; a drive letter (`C:\…`) is not a scheme.
fn url_scheme(target: &str) -> Option<&str> {
    let (scheme, _) = target.split_once(':')?;
    let valid = scheme.len() > 1
        && scheme.starts_with(|c: char| c.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
    valid.then_some(scheme)
}

/// The path a link names: a `file://` URL's (`file:///C:/x` on Windows, `file:///home/x`
/// elsewhere), else the text itself. `None` for a `file:` URL of another host
/// (`file://host/share/x` is that host's share) or one without `//`.
fn link_path(target: &str) -> Option<&str> {
    if !url_scheme(target).is_some_and(|s| s.eq_ignore_ascii_case("file")) {
        return Some(target);
    }
    let rest = target.get(5..)?.strip_prefix("//")?;
    let rest = if rest
        .get(..9)
        .is_some_and(|h| h.eq_ignore_ascii_case("localhost"))
    {
        &rest[9..]
    } else {
        rest
    };
    if !rest.starts_with('/') {
        return None;
    }
    // `/C:/x`: the drive comes after the URL's own slash.
    let drive = rest.get(1..3).is_some_and(|d| d.ends_with(':'));
    Some(if cfg!(windows) && drive {
        &rest[1..]
    } else {
        rest
    })
}

/// A network share (`\\host\share`, `//host/share`) or a device path (`\\?\`, `\\.\`, `\??\`).
fn is_remote(path: &str) -> bool {
    let mut chars = path.chars();
    let slash = |c: Option<char>| matches!(c, Some('\\' | '/'));
    slash(chars.next()) && (slash(chars.next()) || path.starts_with(r"\??\"))
}

/// Windows: a `:` after the drive names an alternate data stream (`x.exe::$DATA` runs the
/// program), never a plain file.
fn has_stream(path: &Path) -> bool {
    let text = path.to_string_lossy();
    let rest = text.get(2..).filter(|_| text.get(1..2) == Some(":"));
    rest.unwrap_or(&text).contains(':')
}

/// The file's type as the OS sees it: its extension, lowercase. On Windows trailing dots and
/// spaces are dropped first, as Windows itself drops them (`setup.exe.` is `setup.exe`).
fn file_type(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    let name = if cfg!(windows) {
        name.trim_end_matches(['.', ' '])
    } else {
        name
    };
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
}

/// A link's path in the OS's separators, relative to `cwd`.
fn resolve(raw: &str, cwd: Option<&Path>) -> PathBuf {
    let path = if cfg!(windows) {
        PathBuf::from(raw.replace('/', "\\"))
    } else {
        PathBuf::from(raw)
    };
    match cwd {
        Some(cwd) if path.is_relative() => cwd.join(path),
        _ => path,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeFs {
        files: &'static [&'static str],
        dirs: &'static [&'static str],
        executables: &'static [&'static str],
    }

    impl Fs for FakeFs {
        fn exists(&self, path: &Path) -> bool {
            let p = path.to_string_lossy();
            self.files.iter().chain(self.dirs).any(|f| *f == p)
        }
        fn is_dir(&self, path: &Path) -> bool {
            self.dirs.contains(&path.to_string_lossy().as_ref())
        }
        fn is_executable(&self, path: &Path) -> bool {
            self.executables.contains(&path.to_string_lossy().as_ref())
        }
    }

    #[cfg(windows)]
    const FS: FakeFs = FakeFs {
        files: &[
            r"C:\src\app\main.ts",
            r"C:\src\app\run.ps1",
            r"C:\tools\setup.EXE",
            r"C:\docs\spec.PDF",
            r"C:\dl\app.application",
            r"C:\dl\pkg.msix",
            r"C:\dl\help.chm",
            r"C:\dl\disk.iso",
            r"C:\dl\add-in.xll",
        ],
        dirs: &[r"C:\src\app", r"C:\dl"],
        executables: &[],
    };

    #[cfg(not(windows))]
    const FS: FakeFs = FakeFs {
        files: &[
            "/src/app/main.ts",
            "/src/app/run.sh",
            "/usr/local/bin/tool",
            "/docs/spec.PDF",
        ],
        dirs: &["/src/app"],
        executables: &["/usr/local/bin/tool"],
    };

    fn plan_of(target: &str, cwd: Option<&str>, editor: bool) -> Result<OpenAction, OpenError> {
        plan(target, Some(12), Some(5), cwd.map(Path::new), &FS, editor)
    }

    #[test]
    fn n02_urls_open_only_for_web_and_mail() {
        assert_eq!(
            plan_of("https://example.com/a?b", None, true),
            Ok(OpenAction::Url("https://example.com/a?b".into()))
        );
        assert!(matches!(
            plan_of("mailto:me@example.com", None, true),
            Ok(OpenAction::Url(_))
        ));
        for bad in [
            "javascript:alert(1)",
            "ms-settings:privacy",
            "smb://host/share",
            "https://a\nb",
        ] {
            assert_eq!(plan_of(bad, None, true), Err(OpenError::Scheme), "{bad}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn n02_files_open_in_the_editor_at_the_line_relative_to_the_folder() {
        assert_eq!(
            plan_of("main.ts", Some(r"C:\src\app"), true),
            Ok(OpenAction::Editor {
                path: r"C:\src\app\main.ts".into(),
                line: 12,
                column: 5,
            })
        );
        assert_eq!(
            plan_of("C:/src/app/main.ts", None, false),
            Ok(OpenAction::Default(r"C:\src\app\main.ts".into()))
        );
        assert!(matches!(
            plan_of("file:///C:/src/app/main.ts", None, true),
            Ok(OpenAction::Editor { .. })
        ));
    }

    #[cfg(not(windows))]
    #[test]
    fn n02_files_open_in_the_editor_at_the_line_relative_to_the_folder() {
        assert_eq!(
            plan_of("main.ts", Some("/src/app"), true),
            Ok(OpenAction::Editor {
                path: "/src/app/main.ts".into(),
                line: 12,
                column: 5,
            })
        );
        assert_eq!(
            plan_of("/src/app/main.ts", None, false),
            Ok(OpenAction::Default("/src/app/main.ts".into()))
        );
        assert!(matches!(
            plan_of("file:///src/app/main.ts", None, true),
            Ok(OpenAction::Editor { .. })
        ));
    }

    #[cfg(windows)]
    #[test]
    fn n02_executables_are_revealed_never_run() {
        assert_eq!(
            plan_of(r"C:\tools\setup.EXE", None, true),
            Ok(OpenAction::Reveal(r"C:\tools\setup.EXE".into()))
        );
        assert_eq!(
            plan_of("run.ps1", Some(r"C:\src\app"), false),
            Ok(OpenAction::Reveal(r"C:\src\app\run.ps1".into()))
        );
        // Types that install, mount or run code when Windows opens them.
        for file in [
            "app.application",
            "pkg.msix",
            "help.chm",
            "disk.iso",
            "add-in.xll",
        ] {
            assert_eq!(
                plan_of(file, Some(r"C:\dl"), false),
                Ok(OpenAction::Reveal(Path::new(r"C:\dl").join(file))),
                "{file}"
            );
        }
    }

    /// N-02: what Windows drops or reads from a name never hides a program's type: trailing dots
    /// and spaces (`setup.exe.` runs `setup.exe`), alternate data streams (`x.exe::$DATA`).
    #[cfg(windows)]
    #[test]
    fn n02_a_disguised_executable_is_still_revealed() {
        const FS: FakeFs = FakeFs {
            files: &[
                r"C:\dl\setup.exe.",
                r"C:\dl\setup.exe . .",
                r"C:\dl\pwn.library-ms",
            ],
            dirs: &[r"C:\dl"],
            executables: &[],
        };
        for name in ["setup.exe.", "setup.exe . .", "pwn.library-ms"] {
            assert_eq!(
                plan(name, Some(1), None, Some(Path::new(r"C:\dl")), &FS, false),
                Ok(OpenAction::Reveal(Path::new(r"C:\dl").join(name))),
                "{name}"
            );
        }
        for target in [r"C:\dl\setup.exe::$DATA", r"C:\dl\notes.txt:evil.exe"] {
            assert_eq!(
                plan(target, None, None, None, &FS, false),
                Err(OpenError::Scheme),
                "{target}"
            );
        }
    }

    /// N-02: a link never makes WolfCmd reach another machine (Windows would sign in to it with
    /// the user's credentials), not even to check that the file exists; a relative link needs a
    /// folder.
    #[test]
    fn n02_network_and_device_paths_are_refused_before_the_disk() {
        struct NoDisk;
        impl Fs for NoDisk {
            fn exists(&self, path: &Path) -> bool {
                panic!("touched the disk for {}", path.display())
            }
            fn is_dir(&self, path: &Path) -> bool {
                self.exists(path)
            }
            fn is_executable(&self, path: &Path) -> bool {
                self.exists(path)
            }
        }
        for target in [
            r"\\attacker\share\doc.txt",
            "//attacker/share/doc.txt",
            r"\\attacker@SSL\x\doc.txt",
            r"\\?\UNC\attacker\share\x.txt",
            r"\??\UNC\attacker\share\x.txt",
            r"\\.\pipe\x",
            "file://attacker/share/doc.txt",
            "file:////attacker/share/doc.txt",
            r"file:\\attacker\share\doc.txt",
        ] {
            assert_eq!(
                plan(target, None, None, None, &NoDisk, true),
                Err(OpenError::Remote),
                "{target}"
            );
        }
        assert!(matches!(
            plan("main.ts", None, None, None, &NoDisk, true),
            Err(OpenError::Missing(_))
        ));
    }

    #[cfg(not(windows))]
    #[test]
    fn n02_executables_are_revealed_never_run() {
        assert_eq!(
            plan_of("run.sh", Some("/src/app"), false),
            Ok(OpenAction::Reveal("/src/app/run.sh".into()))
        );
        // No extension, but the executable bit.
        assert_eq!(
            plan_of("/usr/local/bin/tool", None, true),
            Ok(OpenAction::Reveal("/usr/local/bin/tool".into()))
        );
    }

    #[test]
    fn n02_media_and_documents_open_in_their_default_app() {
        let pdf = if cfg!(windows) {
            r"C:\docs\spec.PDF"
        } else {
            "/docs/spec.PDF"
        };
        assert_eq!(
            plan_of(pdf, None, true),
            Ok(OpenAction::Default(pdf.into()))
        );
    }

    #[test]
    fn n02_folders_open_and_missing_paths_are_errors() {
        let (folder, parent) = if cfg!(windows) {
            (r"C:\src\app", r"C:\src")
        } else {
            ("/src/app", "/src")
        };
        assert_eq!(
            plan_of(folder, None, true),
            Ok(OpenAction::Default(folder.into()))
        );
        assert!(matches!(
            plan_of("nope.ts", Some(parent), true),
            Err(OpenError::Missing(_))
        ));
    }
}
