//! N-05: crash-safe replacement of a whole file. A PC can lose power or hard-reset at any
//! moment; on NTFS a rename can survive a power cut while the renamed file's contents don't,
//! and the next start would then find an empty or zeroed file. Every file WolfCmd saves
//! (`workspaces.json` and its backups, `window.json`, `settings.toml`, the scrollback
//! snapshots, the shell integration scripts) is written through [`write_atomic`]:
//! a temporary sibling, flushed to the disk (`sync_all`), then moved over the target with
//! `MoveFileExW(MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)` on Windows (a plain
//! rename, then a sync of the folder, elsewhere). A reader sees the old file or the new one,
//! never a part of either.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Replaces `path` with `bytes` so that a crash or a power cut at any moment leaves
/// either the old file or the complete new one. The temporary sibling
/// (`.<name>.<pid>-<nanos>.tmp`, same folder so the move stays on one volume) is removed when
/// anything fails. The folder must exist.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let temporary = temporary_sibling(path)?;
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        move_replacing(&temporary, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

fn temporary_sibling(path: &Path) -> std::io::Result<PathBuf> {
    let name = path.file_name().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("not a file path: {}", path.display()),
        )
    })?;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let mut temporary = std::ffi::OsString::from(".");
    temporary.push(name);
    temporary.push(format!(".{}-{nanos}.tmp", std::process::id()));
    Ok(path.with_file_name(temporary))
}

#[cfg(windows)]
fn move_replacing(from: &Path, to: &Path) -> std::io::Result<()> {
    crate::platform::windows::move_write_through(from, to)
}

#[cfg(not(windows))]
fn move_replacing(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::rename(from, to)?;
    // The rename itself is durable once the folder's entry is.
    if let Some(dir) = to.parent() {
        let dir = if dir.as_os_str().is_empty() {
            Path::new(".")
        } else {
            dir
        };
        std::fs::File::open(dir)?.sync_all()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "wcmd-config-fs-{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos())
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn entries(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn n05_write_atomic_creates_and_replaces_without_leaving_a_temporary() {
        let dir = temp_dir("write");
        let path = dir.join("config.toml");
        write_atomic(&path, b"first").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"first");
        write_atomic(&path, b"second, longer").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"second, longer");
        write_atomic(&path, b"").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"");
        assert_eq!(entries(&dir), ["config.toml"]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn n05_a_failed_atomic_write_keeps_the_old_file_and_cleans_up() {
        let dir = temp_dir("fail");
        // The target is a folder: the move fails after the temporary was written.
        let path = dir.join("taken");
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("inside"), b"keep").unwrap();
        assert!(write_atomic(&path, b"new").is_err());
        assert_eq!(std::fs::read(path.join("inside")).unwrap(), b"keep");
        assert_eq!(entries(&dir), ["taken"]);
        // A missing folder fails cleanly too.
        assert!(write_atomic(&dir.join("missing").join("file"), b"x").is_err());
        assert!(write_atomic(Path::new(""), b"x").is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn n05_the_temporary_is_a_hidden_sibling() {
        let temporary = temporary_sibling(Path::new("dir/window.json")).unwrap();
        assert_eq!(temporary.parent(), Some(Path::new("dir")));
        let name = temporary
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert!(name.starts_with(".window.json."), "{name}");
        assert!(
            Path::new(&name).extension().is_some_and(|e| e == "tmp"),
            "{name}"
        );
    }
}
