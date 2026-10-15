//! N-05: `workspaces.json` in the data folder, written crash-safe on every change the UI sends.
//! The user must never lose their work, so loading is careful:
//! - Only a missing file means a fresh start. Any other read error is retried, then the run is
//!   read-only (nothing is saved, so the file stays as it is) and the last backup is shown.
//! - A file that doesn't parse (or isn't UTF-8) is *copied* aside as
//!   `workspaces.broken-<seconds>.json` and the newest good backup opens; when the copy fails
//!   the run is read-only, so the only copy is never overwritten.
//! - A file from a newer WolfCmd is shown when it parses but never overwritten.
//! - A good file is copied to the backups (`backup.rs`) at each start.
//! - N-03: a file of an older format is migrated (`migrate.rs`). Its bytes are first kept as
//!   `workspaces.v<format>-<seconds>.json`, then the migrated document is written at once, so
//!   the copy is made only the first time. When the copy fails the run is read-only.

use std::fmt;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::backup::{self, Backups};
use crate::document::{CURRENT_VERSION, Document};
use crate::migrate::{self, Parsed};

/// The pauses between read attempts when the file exists but can't be read (another program
/// holding it, a slow disk).
const READ_RETRIES: [Duration; 3] = [
    Duration::from_millis(50),
    Duration::from_millis(150),
    Duration::from_millis(400),
];

#[derive(Debug, Clone)]
pub struct StateFile {
    path: PathBuf,
}

/// Why a run saves nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadOnly {
    /// Written by a newer WolfCmd: saving would lose what it knows.
    Newer { version: u64 },
    /// It exists but couldn't be read: saving would replace what we never saw.
    Unreadable { error: String },
    /// It doesn't parse and couldn't be copied aside: saving would replace the only copy.
    NotSetAside { error: String },
    /// N-03: it has an older format and couldn't be copied before migrating: saving would
    /// replace the only copy of it.
    NotBackedUp { version: u64, error: String },
}

impl fmt::Display for ReadOnly {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Newer { version } => write!(
                f,
                "workspaces.json was saved by a newer WolfCmd (format {version}). Changes in \
                 this window aren't saved, so that file stays as it is."
            ),
            Self::Unreadable { error } => write!(
                f,
                "WolfCmd couldn't read workspaces.json ({error}). Changes aren't saved, so the \
                 file stays as it is. Restart WolfCmd once the file can be read."
            ),
            Self::NotSetAside { error } => write!(
                f,
                "workspaces.json is damaged and couldn't be copied aside ({error}). Changes \
                 aren't saved, so the file stays as it is."
            ),
            Self::NotBackedUp { version, error } => write!(
                f,
                "workspaces.json has an older format ({version}) and couldn't be backed up \
                 before updating it ({error}). Changes aren't saved, so the file stays as it is."
            ),
        }
    }
}

/// Where the loaded document came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    /// A good `workspaces.json`.
    File,
    /// There was none: a fresh start.
    Fresh,
    /// `workspaces.json` couldn't be used; this backup was opened.
    Backup(PathBuf),
    /// `workspaces.json` couldn't be used and no backup could either.
    Empty,
}

/// What [`StateFile::load`] found.
#[derive(Debug, Clone)]
pub struct Loaded {
    pub document: Document,
    /// Why nothing may be saved this run; `None` when saving is safe.
    pub read_only: Option<ReadOnly>,
    pub source: Source,
    /// Where a damaged file was copied.
    pub set_aside: Option<PathBuf>,
    /// N-03: where the file of an older format was copied before it was migrated.
    pub migrated: Option<PathBuf>,
}

impl Loaded {
    /// The document did not come from a good `workspaces.json` (fresh start, backup or empty):
    /// files keyed by its panels (scrollback) must not be cleaned up against it.
    pub fn from_fallback(&self) -> bool {
        self.source != Source::File
    }

    /// What the user should be told about the start, if anything (beyond [`Self::read_only`]).
    pub fn note(&self) -> Option<String> {
        let opened = match &self.source {
            Source::File | Source::Fresh => return None,
            Source::Backup(path) => format!("the backup {} was opened", file_name(path)),
            Source::Empty => "no backup could be opened, so WolfCmd started empty".to_owned(),
        };
        Some(match &self.set_aside {
            Some(aside) => format!(
                "workspaces.json was damaged. It was kept as {}, and {opened}.",
                file_name(aside)
            ),
            None => format!("workspaces.json couldn't be used, and {opened}."),
        })
    }
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map_or_else(String::new, |name| name.to_string_lossy().into_owned())
}

impl StateFile {
    pub fn in_dir(dir: &Path) -> Self {
        Self {
            path: dir.join("workspaces.json"),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// `workspaces.json.bak`: the last good file at the latest start.
    pub fn last_backup(&self) -> PathBuf {
        Backups::of(&self.path).last().to_path_buf()
    }

    pub fn load(&self) -> Loaded {
        self.load_on(backup::today())
    }

    /// [`Self::load`] on the day `today` (days since 1970-01-01), which names the daily backup.
    fn load_on(&self, today: u64) -> Loaded {
        let backups = Backups::of(&self.path);
        let bytes = match read_retrying(&self.path) {
            Ok(Some(bytes)) => bytes,
            Ok(None) => {
                return Loaded {
                    document: Document::default(),
                    read_only: None,
                    source: Source::Fresh,
                    set_aside: None,
                    migrated: None,
                };
            }
            Err(error) => {
                tracing::error!(%error, "N-05: workspaces.json can't be read; read-only run");
                let read_only = ReadOnly::Unreadable {
                    error: error.to_string(),
                };
                return fallback(&backups, Some(read_only), None);
            }
        };
        if let Some(version) = migrate::version_of(&bytes)
            && version > u64::from(CURRENT_VERSION)
        {
            tracing::warn!(
                version,
                "N-05: workspaces.json is from a newer WolfCmd; read-only"
            );
            let read_only = Some(ReadOnly::Newer { version });
            return match serde_json::from_slice::<Document>(&bytes) {
                Ok(document) => Loaded {
                    document: document.normalized(),
                    read_only,
                    source: Source::File,
                    set_aside: None,
                    migrated: None,
                },
                Err(_) => fallback(&backups, read_only, None),
            };
        }
        if let Some(parsed) = migrate::parse(&bytes) {
            backups.keep(&bytes, today);
            if parsed.from < u64::from(CURRENT_VERSION) {
                return self.migrated(&bytes, parsed);
            }
            return Loaded {
                document: parsed.document,
                read_only: None,
                source: Source::File,
                set_aside: None,
                migrated: None,
            };
        }
        tracing::warn!("N-05: workspaces.json doesn't parse; copying it aside");
        match self.copy_beside("broken", &bytes) {
            Ok(aside) => fallback(&backups, None, Some(aside)),
            Err(error) => {
                tracing::error!(%error, "N-05: could not copy the damaged file; read-only run");
                let read_only = ReadOnly::NotSetAside {
                    error: error.to_string(),
                };
                fallback(&backups, Some(read_only), None)
            }
        }
    }

    /// N-03: a file of an older format, migrated: its bytes are kept as
    /// `workspaces.v<format>-<seconds>.json` first, then the migrated document replaces it at
    /// once (the next start reads the current format, so no second copy is made). When the copy
    /// fails the run is read-only: the older file stays the only copy.
    fn migrated(&self, bytes: &[u8], parsed: Parsed) -> Loaded {
        let Parsed { document, from } = parsed;
        match self.copy_beside(&format!("v{from}"), bytes) {
            Ok(copy) => {
                tracing::info!(from, copy = %copy.display(), "N-03: workspaces.json migrated");
                if let Err(error) = self.save(&document) {
                    // The UI's next change saves it again.
                    tracing::warn!(%error, "N-03: could not write the migrated workspaces.json");
                }
                Loaded {
                    document,
                    read_only: None,
                    source: Source::File,
                    set_aside: None,
                    migrated: Some(copy),
                }
            }
            Err(error) => {
                tracing::error!(%error, "N-03: could not back up the older file; read-only run");
                Loaded {
                    document,
                    read_only: Some(ReadOnly::NotBackedUp {
                        version: from,
                        error: error.to_string(),
                    }),
                    source: Source::File,
                    set_aside: None,
                    migrated: None,
                }
            }
        }
    }

    /// Keeps the file's bytes as `workspaces.<tag>-<seconds>.json` (a new name each time; `tag`:
    /// `broken` for a damaged file, `v1` for one migrated from format 1), flushed to the disk
    /// before the original may be replaced.
    fn copy_beside(&self, tag: &str, bytes: &[u8]) -> std::io::Result<PathBuf> {
        let seconds = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        let mut n = 0;
        let aside = loop {
            let suffix = if n == 0 {
                String::new()
            } else {
                format!("-{n}")
            };
            let aside = self
                .path
                .with_file_name(format!("workspaces.{tag}-{seconds}{suffix}.json"));
            if !aside.exists() {
                break aside;
            }
            n += 1;
        };
        wcmd_config::fs::write_atomic(&aside, bytes)?;
        Ok(aside)
    }

    /// Writes the whole document (normalized), crash-safe.
    pub fn save(&self, document: &Document) -> std::io::Result<()> {
        let text = serde_json::to_vec_pretty(&document.clone().normalized())
            .map_err(std::io::Error::other)?;
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        wcmd_config::fs::write_atomic(&self.path, &text)
    }
}

/// The newest good backup, else an empty document.
fn fallback(backups: &Backups, read_only: Option<ReadOnly>, set_aside: Option<PathBuf>) -> Loaded {
    let (document, source) = match backups.newest_good() {
        Some((path, document)) => {
            tracing::warn!(backup = %path.display(), "N-05: opening the newest good backup");
            (document, Source::Backup(path))
        }
        None => (Document::default(), Source::Empty),
    };
    Loaded {
        document,
        read_only,
        source,
        set_aside,
        migrated: None,
    }
}

/// The file's bytes; `None` only when it doesn't exist. Other errors are retried
/// ([`READ_RETRIES`]) before they are returned.
fn read_retrying(path: &Path) -> std::io::Result<Option<Vec<u8>>> {
    let mut pauses = READ_RETRIES.iter();
    loop {
        match std::fs::read(path) {
            Ok(bytes) => return Ok(Some(bytes)),
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => match pauses.next() {
                Some(pause) => {
                    tracing::warn!(%error, "N-05: workspaces.json can't be read yet; retrying");
                    std::thread::sleep(*pause);
                }
                None => return Err(error),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document::{Layout, Panel, Tab, TerminalContent, Workspace};

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wcmd-state-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample(panel: &str) -> Document {
        Document {
            version: CURRENT_VERSION,
            workspaces: vec![Workspace {
                id: "w1".into(),
                name: "App".into(),
                folder: Some("c:/dev/app".into()),
                tabs: vec![Tab {
                    id: "t1".into(),
                    name: String::new(),
                    layout: Some(Layout::Panel(Panel::terminal(
                        panel,
                        TerminalContent {
                            profile: Some("pwsh".into()),
                            cwd: Some("c:/dev/app".into()),
                            ..TerminalContent::default()
                        },
                    ))),
                    focused: Some(panel.into()),
                    maximized: None,
                }],
                active_tab: Some("t1".into()),
                main: None,
            }],
            active: Some("w1".into()),
        }
    }

    fn broken_copies(dir: &Path) -> Vec<PathBuf> {
        std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.to_string_lossy().contains("workspaces.broken-"))
            .collect()
    }

    #[test]
    fn n05_the_document_round_trips_and_a_missing_file_is_a_fresh_start() {
        let dir = temp_dir("round");
        let file = StateFile::in_dir(&dir);
        let fresh = file.load();
        assert_eq!(fresh.source, Source::Fresh);
        assert!(fresh.read_only.is_none() && fresh.from_fallback() && fresh.note().is_none());
        file.save(&sample("p1")).unwrap();
        let loaded = file.load();
        assert_eq!(loaded.document, sample("p1"));
        assert!(loaded.read_only.is_none());
        assert!(!loaded.from_fallback());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn n05_a_newer_file_is_read_only_even_when_it_does_not_parse() {
        let dir = temp_dir("newer");
        let file = StateFile::in_dir(&dir);
        std::fs::write(
            file.path(),
            r#"{"version":9,"workspaces":[],"future":true}"#,
        )
        .unwrap();
        let loaded = file.load();
        assert_eq!(loaded.read_only, Some(ReadOnly::Newer { version: 9 }));
        assert!(!loaded.from_fallback());
        let future = r#"{"version":9,"workspaces":"a new shape"}"#;
        std::fs::write(file.path(), future).unwrap();
        let loaded = file.load();
        assert_eq!(loaded.read_only, Some(ReadOnly::Newer { version: 9 }));
        assert!(loaded.from_fallback());
        // Never set aside or touched.
        assert_eq!(broken_copies(&dir).len(), 0);
        assert_eq!(std::fs::read_to_string(file.path()).unwrap(), future);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn n05_a_broken_file_is_copied_aside_and_the_last_backup_opens() {
        let dir = temp_dir("broken");
        let file = StateFile::in_dir(&dir);
        file.save(&sample("good")).unwrap();
        // A good start keeps it as the latest backup.
        assert_eq!(file.load().document, sample("good"));
        assert!(file.last_backup().is_file());
        std::fs::write(file.path(), "{oops").unwrap();
        let loaded = file.load();
        assert_eq!(loaded.document, sample("good"));
        assert_eq!(loaded.source, Source::Backup(file.last_backup()));
        assert!(loaded.read_only.is_none() && loaded.from_fallback());
        let copies = broken_copies(&dir);
        assert_eq!(copies.len(), 1);
        assert_eq!(std::fs::read_to_string(&copies[0]).unwrap(), "{oops");
        // Copied, not moved: the original is still there until a save replaces it.
        assert!(file.path().is_file());
        assert!(loaded.note().unwrap().contains("workspaces.broken-"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn n05_invalid_utf8_is_set_aside_and_with_no_backup_the_start_is_empty() {
        let dir = temp_dir("utf8");
        let file = StateFile::in_dir(&dir);
        let bytes = b"{\"version\":1,\"workspaces\":[{\"name\":\"\xff\xfe\"}]}";
        std::fs::write(file.path(), bytes).unwrap();
        let loaded = file.load();
        assert_eq!(loaded.source, Source::Empty);
        assert_eq!(loaded.document, Document::default());
        let copies = broken_copies(&dir);
        assert_eq!(std::fs::read(&copies[0]).unwrap(), bytes);
        // A second damaged start keeps both copies.
        std::fs::write(file.path(), b"\xff").unwrap();
        file.load();
        assert_eq!(broken_copies(&dir).len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn n05_daily_backups_keep_seven_days() {
        let dir = temp_dir("daily");
        let file = StateFile::in_dir(&dir);
        file.save(&sample("p1")).unwrap();
        let start = 20_700;
        for day in start..start + 10 {
            file.load_on(day);
        }
        let backups = Backups::of(file.path());
        let kept: Vec<bool> = (start..start + 10)
            .map(|day| backups.daily(day).is_file())
            .collect();
        assert_eq!(
            kept,
            [
                false, false, false, true, true, true, true, true, true, true
            ]
        );
        // A later start the same day doesn't replace that day's copy.
        file.save(&sample("p2")).unwrap();
        file.load_on(start + 9);
        let today = std::fs::read(backups.daily(start + 9)).unwrap();
        assert_eq!(backup::parse_current(&today).unwrap(), sample("p1"));
        let last = std::fs::read(file.last_backup()).unwrap();
        assert_eq!(backup::parse_current(&last).unwrap(), sample("p2"));
        // With the latest copy damaged too, the newest daily one opens.
        std::fs::write(file.last_backup(), "{").unwrap();
        std::fs::write(file.path(), "{").unwrap();
        let loaded = file.load_on(start + 9);
        assert_eq!(loaded.source, Source::Backup(backups.daily(start + 9)));
        assert_eq!(loaded.document, sample("p1"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn copies(dir: &Path, prefix: &str) -> Vec<PathBuf> {
        std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| {
                p.file_name()
                    .is_some_and(|n| n.to_string_lossy().starts_with(prefix))
            })
            .collect()
    }

    const V1_FILE: &str = include_str!("../fixtures/workspaces-v1.json");

    #[test]
    fn n03_a_v1_file_is_backed_up_once_then_saved_as_v2() {
        let dir = temp_dir("v1");
        let file = StateFile::in_dir(&dir);
        std::fs::write(file.path(), V1_FILE).unwrap();
        let loaded = file.load();
        assert!(loaded.read_only.is_none() && !loaded.from_fallback());
        assert_eq!(loaded.document.panel_ids().len(), 4);
        // The v1 bytes are kept, untouched, before anything replaces them.
        let copy = loaded.migrated.clone().expect("a backup of the v1 file");
        assert!(
            copy.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("workspaces.v1-")
        );
        assert_eq!(std::fs::read_to_string(&copy).unwrap(), V1_FILE);
        // The file is the migrated document now, in format 2.
        let saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(file.path()).unwrap()).unwrap();
        assert_eq!(saved["version"], 2);
        // A second start reads format 2 and makes no second copy.
        let again = file.load();
        assert_eq!(again.migrated, None);
        assert_eq!(again.document, loaded.document);
        assert_eq!(copies(&dir, "workspaces.v1-"), vec![copy]);
        // The backups of a v1 file open too (migrated).
        std::fs::write(file.last_backup(), V1_FILE).unwrap();
        std::fs::write(file.path(), "{").unwrap();
        let from_backup = file.load();
        assert_eq!(from_backup.source, Source::Backup(file.last_backup()));
        assert_eq!(from_backup.document, loaded.document);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// N-03: when the older file can't be backed up (here the data folder is a file, so nothing
    /// can be written in it), the run is read-only and the file stays as it was.
    #[test]
    fn n03_a_v1_file_that_cannot_be_backed_up_is_read_only_and_untouched() {
        let dir = temp_dir("v1-nocopy");
        let file = StateFile::in_dir(&dir);
        std::fs::write(file.path(), V1_FILE).unwrap();
        let parsed = migrate::parse(V1_FILE.as_bytes()).unwrap();
        // A file where the data folder should be: no copy can be written beside it.
        let blocked = StateFile {
            path: file.path().join("workspaces.json"),
        };
        let loaded = blocked.migrated(V1_FILE.as_bytes(), parsed.clone());
        assert!(matches!(
            loaded.read_only,
            Some(ReadOnly::NotBackedUp { version: 1, .. })
        ));
        assert!(
            loaded
                .read_only
                .unwrap()
                .to_string()
                .contains("older format")
        );
        assert_eq!(loaded.document, parsed.document);
        assert_eq!(std::fs::read_to_string(file.path()).unwrap(), V1_FILE);
        assert_eq!(copies(&dir, "workspaces.v1-"), Vec::<PathBuf>::new());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A handle without any sharing (another program holding the file) makes every read fail.
    #[cfg(windows)]
    #[test]
    fn n05_a_locked_file_is_read_only_and_never_touched() {
        use std::os::windows::fs::OpenOptionsExt as _;
        let dir = temp_dir("locked");
        let file = StateFile::in_dir(&dir);
        file.save(&sample("p1")).unwrap();
        file.load();
        let before = std::fs::read(file.path()).unwrap();
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(file.path())
            .unwrap();
        let loaded = file.load();
        drop(lock);
        assert!(matches!(
            loaded.read_only,
            Some(ReadOnly::Unreadable { .. })
        ));
        assert!(
            loaded
                .read_only
                .unwrap()
                .to_string()
                .contains("couldn't read")
        );
        // The backup is shown; nothing was set aside or rewritten.
        assert_eq!(loaded.source, Source::Backup(file.last_backup()));
        assert_eq!(loaded.document, sample("p1"));
        assert_eq!(broken_copies(&dir).len(), 0);
        assert_eq!(std::fs::read(file.path()).unwrap(), before);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
