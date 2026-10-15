//! N-05: scrollback snapshots on disk, `<data>/scrollback/<blockId>.snap`, so a terminal
//! panel shows what it showed before WolfCmd restarted (dim, above a divider) and its new
//! shell starts below. The bytes are `wcmd_term::snapshot`'s; this module decides when and
//! where they are kept.
//!
//! - **When:** the session host stages a snapshot of a session whose output changed once it
//!   has been quiet for [`SAVE_WHEN_QUIET`], or [`SAVE_AT_LATEST`] after its first unsaved
//!   output (thread `session-keeper`); when a session ends; and on quit or when Windows ends
//!   the user's session (`flush_snapshots`, from `RunEvent::Exit` and `WM_QUERYENDSESSION`).
//!   Staging copies the bytes in memory; writing happens on the keeper, the ended session's
//!   reader or the quit, never on an IPC handler.
//! - **How:** `wcmd_config::fs::write_atomic` (a crash never leaves half a file under the
//!   real name). Writes are serialized, newest last.
//! - **What not:** a panel no longer in the workspace document (its file is left as it is; the
//!   startup cleanup removes it), anything while the document is read-only (written by a newer
//!   WolfCmd).
//! - **Restore:** when a panel's new shell starts, once per block per UI page (a second shell
//!   of the same block shows only the new shell). A reloaded page attaches to the running
//!   sessions instead (their replay has the restored part), and restores only for panels whose
//!   shell has ended meanwhile.
//! - **Cleanup:** once at startup, the files of panels not in the document go; skipped when the
//!   document is a fallback (the real one could not be read), so its scrollback survives.
//! - **Privacy:** local files in the data folder only, never sent anywhere. Never log their
//!   contents.

use std::collections::{HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::state::StateService;

/// The folder in the data folder.
pub(crate) const DIR: &str = "scrollback";
/// A changed session is saved once its output has paused this long…
pub(crate) const SAVE_WHEN_QUIET: Duration = Duration::from_secs(5);
/// …or this long after its first unsaved output, whichever comes first.
pub(crate) const SAVE_AT_LATEST: Duration = Duration::from_secs(15);

const EXTENSION: &str = ".snap";

/// Whether a block is a panel of the workspace document now (its snapshot is saved and
/// restored); a block that isn't (closed, or not there yet) is left as it is.
pub(crate) type PanelCheck = Box<dyn Fn(&str) -> bool + Send + Sync>;

#[derive(Debug, Clone)]
struct Staged {
    saved_at: u64,
    body: Vec<u8>,
}

pub(crate) struct SnapshotStore {
    dir: PathBuf,
    /// False while another WolfCmd owns the data folder: restore only.
    writable: bool,
    is_panel: PanelCheck,
    /// Captured and not yet written, the newest per block. A restore reads these first.
    staged: Mutex<HashMap<String, Staged>>,
    /// Held while writing, so two threads never write one block's temporary file at once.
    writing: Mutex<()>,
    /// The blocks of the document at startup, until the first cleanup used them.
    startup_blocks: Mutex<Option<HashSet<String>>>,
    /// Blocks restored since the UI page loaded.
    restored: Mutex<HashSet<String>>,
}

impl std::fmt::Debug for SnapshotStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SnapshotStore")
            .field("dir", &self.dir)
            .field("writable", &self.writable)
            .finish_non_exhaustive()
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Now, in Unix seconds.
pub(crate) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

impl SnapshotStore {
    /// `startup_blocks`: the blocks of the workspace document now; files of any other block are
    /// removed by [`Self::clean_up`]. `None`: nothing is removed.
    pub(crate) fn new(
        data_dir: &Path,
        writable: bool,
        startup_blocks: Option<HashSet<String>>,
        is_panel: PanelCheck,
    ) -> Self {
        Self {
            dir: data_dir.join(DIR),
            writable,
            is_panel,
            staged: Mutex::default(),
            writing: Mutex::default(),
            startup_blocks: Mutex::new(startup_blocks),
            restored: Mutex::default(),
        }
    }

    /// The app's store: in `data_dir`, with the rules of the workspace document, read-only
    /// while the state is.
    pub(crate) fn for_app(data_dir: &Path, state: &Arc<StateService>) -> Self {
        let check = Arc::clone(state);
        Self::new(
            data_dir,
            !state.read_only(),
            // The startup cleanup trusts only a document that was really read. N-03: it keeps the
            // files of every panel, of any kind (a kind this WolfCmd doesn't know may own one).
            (!state.is_fallback()).then(|| state.panel_ids()),
            Box::new(move |block: &str| check.has_panel(block)),
        )
    }

    /// The block's file, if its ID is plain enough to be a file name.
    fn path(&self, block_id: &str) -> Option<PathBuf> {
        let plain = !block_id.is_empty()
            && block_id.len() <= 128
            && !block_id.starts_with('.')
            && block_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
        plain.then(|| self.dir.join(format!("{block_id}{EXTENSION}")))
    }

    /// Keeps `body` (a dim `Terminal::snapshot`) as the block's newest snapshot, to be written
    /// by the next [`Self::write_staged`].
    pub(crate) fn stage(&self, block_id: &str, saved_at: u64, body: Vec<u8>) {
        if !self.writable {
            return;
        }
        lock(&self.staged).insert(block_id.to_owned(), Staged { saved_at, body });
    }

    /// Writes (or removes) the staged snapshots. Errors are logged; a snapshot that could not
    /// be written stays staged (unless a newer one was staged meanwhile) and is tried again by
    /// the next write.
    pub(crate) fn write_staged(&self) {
        let _writing = lock(&self.writing);
        let staged = std::mem::take(&mut *lock(&self.staged));
        for (block, snapshot) in staged {
            if let Err(error) = self.save(&block, &snapshot) {
                tracing::warn!(%error, "N-05: could not save a scrollback snapshot; kept for later");
                lock(&self.staged).entry(block).or_insert(snapshot);
            }
        }
    }

    fn save(&self, block_id: &str, snapshot: &Staged) -> io::Result<()> {
        let Some(path) = self.path(block_id) else {
            return Ok(());
        };
        if !(self.is_panel)(block_id) {
            return Ok(());
        }
        if snapshot.body.is_empty() {
            // Nothing to show (`cls` cleared it): no file.
            return remove(&path);
        }
        let file = wcmd_term::snapshot::encode(snapshot.saved_at, &snapshot.body);
        write_atomically(&path, &file)
    }

    /// The saved snapshot of a block (the staged one first), if any. Waits for a write in
    /// progress, so a snapshot being written is found either staged or in its file.
    fn load(&self, block_id: &str) -> Option<Staged> {
        let _writing = lock(&self.writing);
        if let Some(staged) = lock(&self.staged).get(block_id) {
            return Some(staged.clone());
        }
        let file = std::fs::read(self.path(block_id)?).ok()?;
        let (saved_at, body) = wcmd_term::snapshot::decode(&file)?;
        Some(Staged {
            saved_at,
            body: body.to_vec(),
        })
    }

    /// What a new session of `block_id` shows first: its last snapshot, dim, above the divider
    /// with the time it was saved. Only the first session of a block since the page loaded;
    /// `None` when there is nothing to restore.
    pub(crate) fn take_restore(&self, block_id: &str) -> Option<Vec<u8>> {
        if !lock(&self.restored).insert(block_id.to_owned()) {
            return None;
        }
        if !(self.is_panel)(block_id) {
            return None;
        }
        let snapshot = self.load(block_id)?;
        let shown = wcmd_term::snapshot::restored(&snapshot.body, &label(snapshot.saved_at));
        (!shown.is_empty()).then_some(shown)
    }

    /// The UI page (re)loaded: a panel whose shell ended meanwhile starts a new one, which
    /// restores once more.
    pub(crate) fn new_page(&self) {
        lock(&self.restored).clear();
    }

    /// Removes the files of blocks that were not in the document at startup, and leftover
    /// temporary files. Once per run (later calls do nothing).
    pub(crate) fn clean_up(&self) {
        let Some(keep) = lock(&self.startup_blocks).take() else {
            return;
        };
        if !self.writable {
            return;
        }
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return;
        };
        let _writing = lock(&self.writing);
        for entry in entries.filter_map(Result::ok) {
            let name = entry.file_name().to_string_lossy().into_owned();
            if stale(&name, &keep) {
                let _ = remove(&entry.path());
            }
        }
    }
}

/// Pure: whether a file of the snapshot folder goes (a snapshot of a block not in `keep`, or
/// anything that isn't a `.snap`, such as a leftover temporary of `write_atomic`).
fn stale(name: &str, keep: &HashSet<String>) -> bool {
    name.strip_suffix(EXTENSION)
        .is_none_or(|block| !keep.contains(block))
}

fn remove(path: &Path) -> io::Result<()> {
    match std::fs::remove_file(path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

/// `wcmd_config::fs::write_atomic` (a flushed temporary sibling moved over the old file
/// with write-through): a crash or a power cut leaves the old snapshot or the new one. Its
/// temporary (`.<blockId>.snap.<pid>-<nanos>.tmp`) is not a `.snap`, so a leftover goes in the
/// startup cleanup.
fn write_atomically(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    wcmd_config::fs::write_atomic(path, bytes)
}

/// A wall-clock time, to the minute.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WallClock {
    pub(crate) year: u16,
    pub(crate) month: u8,
    pub(crate) day: u8,
    pub(crate) hour: u8,
    pub(crate) minute: u8,
}

impl std::fmt::Display for WallClock {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{:04}-{:02}-{:02} {:02}:{:02}",
            self.year, self.month, self.day, self.hour, self.minute
        )
    }
}

/// Pure: a Unix time in UTC (the civil calendar from days, H. Hinnant's algorithm).
pub(crate) fn utc(unix_seconds: u64) -> WallClock {
    let days = i64::try_from(unix_seconds / 86_400).unwrap_or(0);
    let seconds = unix_seconds % 86_400;
    // Days since 0000-03-01, in 400-year eras (a year runs March to February here).
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let march_based_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * march_based_month + 2) / 5 + 1;
    let month = if march_based_month < 10 {
        march_based_month + 3
    } else {
        march_based_month - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    WallClock {
        year: u16::try_from(year).unwrap_or(u16::MAX),
        month: u8::try_from(month).unwrap_or(1),
        day: u8::try_from(day).unwrap_or(1),
        hour: u8::try_from(seconds / 3_600).unwrap_or(0),
        minute: u8::try_from(seconds % 3_600 / 60).unwrap_or(0),
    }
}

/// The divider's time: local (`2026-10-12 18:05`), or UTC when the local time is unknown.
fn label(saved_at: u64) -> String {
    match crate::platform::local_time(saved_at) {
        Some(local) => local.to_string(),
        None => format!("{} UTC", utc(saved_at)),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("wcmd-n05-{name}-{}-{}", std::process::id(), now()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    /// Every block is a panel while the shared switch is on.
    fn store(dir: &Path, keep: &[&str]) -> (SnapshotStore, Arc<AtomicBool>) {
        let switch = Arc::new(AtomicBool::new(true));
        let panel_switch = Arc::clone(&switch);
        let store = SnapshotStore::new(
            dir,
            true,
            Some(keep.iter().map(|b| (*b).to_owned()).collect()),
            Box::new(move |_: &str| panel_switch.load(Ordering::SeqCst)),
        );
        (store, switch)
    }

    fn file(dir: &Path, block: &str) -> PathBuf {
        dir.join(DIR).join(format!("{block}{EXTENSION}"))
    }

    #[test]
    fn n05_atomic_save_and_restore_once_per_page() {
        let dir = temp_dir("save");
        let (store, _) = store(&dir, &["b-1"]);
        store.stage("b-1", 1_760_000_000, b"\x1b[0;2mold\x1b[0m\r\n".to_vec());
        store.write_staged();

        let path = file(&dir, "b-1");
        let saved = std::fs::read(&path).expect("saved");
        assert_eq!(
            wcmd_term::snapshot::decode(&saved),
            Some((1_760_000_000, &b"\x1b[0;2mold\x1b[0m\r\n"[..]))
        );
        // No temporary file is left next to it.
        let names: Vec<_> = std::fs::read_dir(dir.join(DIR))
            .expect("folder")
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["b-1.snap"]);

        let shown = String::from_utf8(store.take_restore("b-1").expect("restored")).expect("utf-8");
        assert!(shown.contains("old"));
        assert!(shown.contains("── restored from "));
        // A second session of the block in the same page (a Restart) shows only its shell.
        assert_eq!(store.take_restore("b-1"), None);
        store.new_page();
        assert!(store.take_restore("b-1").is_some());
        // Nothing saved for this block.
        assert_eq!(store.take_restore("b-2"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn n05_a_restore_reads_the_staged_snapshot_first() {
        let dir = temp_dir("staged");
        let (store, _) = store(&dir, &[]);
        store.stage("b-1", 10, b"x\r\n".to_vec());
        store.write_staged();
        store.stage("b-1", 20, b"newer\r\n".to_vec());
        let shown = String::from_utf8(store.take_restore("b-1").expect("restored")).expect("utf-8");
        assert!(shown.contains("newer"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn n05_closed_panels_keep_their_file_and_empty_snapshots_remove_it() {
        let dir = temp_dir("closed");
        let (store, switch) = store(&dir, &[]);
        store.stage(
            "b-1",
            1,
            b"shown
"
            .to_vec(),
        );
        store.write_staged();
        assert!(file(&dir, "b-1").exists());

        // Not in the document (closed): the file stays until the next start's cleanup.
        switch.store(false, Ordering::SeqCst);
        store.stage(
            "b-1",
            2,
            b"later
"
            .to_vec(),
        );
        store.write_staged();
        let saved = std::fs::read(file(&dir, "b-1")).expect("kept");
        assert_eq!(
            wcmd_term::snapshot::decode(&saved).map(|(at, _)| at),
            Some(1)
        );
        assert_eq!(store.take_restore("b-1"), None);

        // An empty snapshot (`cls`) removes the file.
        switch.store(true, Ordering::SeqCst);
        store.stage("b-1", 5, Vec::new());
        store.write_staged();
        assert!(!file(&dir, "b-1").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A snapshot whose write fails stays staged for the next write, unless a newer one of the
    /// block was staged while it was being written.
    #[test]
    fn n05_a_snapshot_that_could_not_be_written_is_kept_for_the_next_write() {
        let dir = temp_dir("failed");
        let (store, _) = store(&dir, &[]);
        // A folder where the file goes: the write fails.
        let blocker = file(&dir, "b-1");
        std::fs::create_dir_all(&blocker).expect("folder");
        store.stage("b-1", 10, b"kept\r\n".to_vec());
        store.write_staged();
        assert_eq!(lock(&store.staged).get("b-1").map(|s| s.saved_at), Some(10));
        std::fs::remove_dir(&blocker).expect("removed");
        store.write_staged();
        assert!(lock(&store.staged).is_empty());
        let saved = std::fs::read(&blocker).expect("written");
        assert_eq!(
            wcmd_term::snapshot::decode(&saved).map(|(at, _)| at),
            Some(10)
        );

        let _ = std::fs::remove_dir_all(&dir);

        // A newer snapshot staged during the failed write wins over the failed one.
        let dir = temp_dir("failed-newer");
        let slot: Arc<std::sync::OnceLock<std::sync::Weak<SnapshotStore>>> = Arc::default();
        let hook = Arc::clone(&slot);
        let fired = AtomicBool::new(false);
        let store = Arc::new(SnapshotStore::new(
            &dir,
            true,
            None,
            Box::new(move |block: &str| {
                // Asked while writing: a newer snapshot comes in meanwhile.
                if !fired.swap(true, Ordering::SeqCst)
                    && let Some(store) = hook.get().and_then(std::sync::Weak::upgrade)
                {
                    store.stage(block, 20, b"newer\r\n".to_vec());
                }
                true
            }),
        ));
        slot.set(Arc::downgrade(&store)).expect("set once");
        let blocker = file(&dir, "b-1");
        std::fs::create_dir_all(&blocker).expect("folder");
        store.stage("b-1", 10, b"older\r\n".to_vec());
        store.write_staged();
        assert_eq!(lock(&store.staged).get("b-1").map(|s| s.saved_at), Some(20));
        std::fs::remove_dir(&blocker).expect("removed");
        store.write_staged();
        let saved = std::fs::read(&blocker).expect("written");
        assert_eq!(
            wcmd_term::snapshot::decode(&saved).map(|(at, _)| at),
            Some(20)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn n05_read_only_runs_never_write() {
        let dir = temp_dir("readonly");
        let store = SnapshotStore::new(&dir, false, Some(HashSet::new()), Box::new(|_: &str| true));
        store.stage("b-1", 1, b"x\r\n".to_vec());
        store.write_staged();
        assert!(!dir.join(DIR).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn n05_cleanup_removes_unknown_blocks_once() {
        let dir = temp_dir("cleanup");
        let folder = dir.join(DIR);
        std::fs::create_dir_all(&folder).expect("folder");
        for name in ["b-1.snap", "gone.snap", ".b-1.snap.12-34.tmp", "notes.txt"] {
            std::fs::write(folder.join(name), b"x").expect("file");
        }
        let (store, _) = store(&dir, &["b-1"]);
        store.clean_up();
        let mut names: Vec<_> = std::fs::read_dir(&folder)
            .expect("folder")
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, ["b-1.snap"]);

        // Once per run: a block closed later keeps its file until the next start.
        std::fs::write(folder.join("later.snap"), b"x").expect("file");
        store.clean_up();
        assert!(folder.join("later.snap").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn n05_a_fallback_document_keeps_every_snapshot() {
        let dir = temp_dir("fallback");
        let folder = dir.join(DIR);
        std::fs::create_dir_all(&folder).expect("folder");
        std::fs::write(folder.join("b-1.snap"), b"x").expect("file");
        let store = SnapshotStore::new(&dir, true, None, Box::new(|_: &str| true));
        store.clean_up();
        assert!(folder.join("b-1.snap").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn n05_block_ids_must_be_plain_file_names() {
        let (store, _) = store(Path::new("data"), &[]);
        assert!(store.path("b-1_x.2").is_some());
        let long = "x".repeat(129);
        for bad in ["", "..", ".hidden", "a/b", "a\\b", "c:x", long.as_str()] {
            assert_eq!(store.path(bad), None, "{bad}");
        }
    }

    #[test]
    fn n05_divider_time() {
        assert_eq!(utc(0).to_string(), "1970-01-01 00:00");
        assert_eq!(utc(1_760_000_000).to_string(), "2025-10-09 08:53");
        assert_eq!(utc(951_782_400).to_string(), "2000-02-29 00:00");
        assert_eq!(utc(1_767_225_599).to_string(), "2025-12-31 23:59");
    }
}
