//! N-05: the workspace document and the window bounds, owned here between the UI and the disk.
//! The UI sends every change (`state_save`); a writer thread saves it at once, crash-safe, the
//! newest document winning when changes come faster than the disk (nothing waits on IPC).
//! The user must never lose their work: a failed save is kept and retried with a growing pause
//! ([`RETRY_FIRST`] up to [`RETRY_MAX`]) unless a newer document replaced it, and the UI is told
//! ([`StateHealth`]) until a save succeeds again. A read-only run (`wcmd_state::ReadOnly`) saves
//! nothing and says why. On quit, [`StateService::flush`] waits at most [`FLUSH_WAIT`], then
//! writes on the calling thread, so a slow or missing writer never hangs the exit. Once
//! Windows is ending the session, or the app quits, later documents are not written
//! ([`StateService::freeze`]), so the session is kept as it was before the shutdown ended its
//! programs.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError, TryLockError};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use specta::Type;
use wcmd_state::{Document, StateFile, WindowBounds, WindowFile};

/// The first pause after a failed save; it doubles up to [`RETRY_MAX`].
const RETRY_FIRST: Duration = Duration::from_millis(200);
const RETRY_MAX: Duration = Duration::from_secs(5);
/// How long [`StateService::flush`] waits for the writer before writing itself.
const FLUSH_WAIT: Duration = Duration::from_secs(5);

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// N-05: what the user should know about saving, sent to the UI at load (`state_load`) and as
/// the `state-health` event whenever it changes. Each text is ready to show.
#[derive(
    Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type, tauri_specta::Event,
)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StateHealth {
    /// Why nothing is saved this run (a newer, unreadable or damaged file is left as it is).
    pub(crate) read_only: Option<String>,
    /// The latest save failed and is being retried; `None` again once a save succeeds.
    pub(crate) save_error: Option<String>,
    /// What happened at the start (a damaged file kept aside, a backup opened).
    pub(crate) note: Option<String>,
}

/// What is waiting to be written.
#[derive(Debug, Default)]
struct Pending {
    /// The newest document not yet on disk, with its number (the order the UI saved them in).
    document: Option<(u64, Document)>,
    window: Option<WindowBounds>,
    /// A write is in progress (`flush` waits for it too).
    writing: bool,
    /// `flush` asked: the writer skips its pause before the next retry.
    urgent: bool,
}

/// N-05: whether the session or the app is ending ([`StateService::freeze`]).
#[derive(Debug, Default)]
struct Frozen {
    on: bool,
    /// A document came while frozen (written at [`StateService::thaw`]).
    missed: bool,
}

/// Hears every [`StateHealth`] change (the UI's event).
type Notify = Box<dyn Fn(&StateHealth) + Send + Sync>;

struct Notifier(Mutex<Option<Notify>>);

impl std::fmt::Debug for Notifier {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Notifier")
    }
}

#[derive(Debug)]
pub(crate) struct StateService {
    file: StateFile,
    window_file: WindowFile,
    /// Shown, never saved (see [`StateHealth::read_only`]).
    read_only: bool,
    /// The document did not come from a good file.
    from_fallback: bool,
    document: Mutex<Document>,
    window: Mutex<Option<WindowBounds>>,
    pending: Mutex<Pending>,
    wake: Condvar,
    /// The number of the latest document the UI saved.
    saved: Mutex<u64>,
    /// The page's number (`state_save`'s `seq`) of the newest document it saved; 0 after a
    /// page load. Held while a save is applied, so saves are applied one at a time, in order.
    save_order: Mutex<u32>,
    /// The number of the newest document on disk. Held while writing, so two writers (the
    /// thread and a late `flush`) never put an older document over a newer one.
    written: Mutex<u64>,
    /// N-05: whether documents are written now ([`Self::freeze`]). Held while a document is
    /// queued, so none is queued after the freeze.
    frozen: Mutex<Frozen>,
    /// The writer thread is running (false when it never started or has ended).
    writer_alive: Arc<AtomicBool>,
    health: Mutex<StateHealth>,
    notify: Notifier,
}

/// Clears the writer's flag when its thread ends, a panic included.
struct AliveGuard(Arc<AtomicBool>);

impl Drop for AliveGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl StateService {
    /// Loads the data folder's document and window bounds and starts the writer thread.
    pub(crate) fn open(dir: &Path) -> Arc<Self> {
        let service = Arc::new(Self::load(dir));
        service.writer_alive.store(true, Ordering::SeqCst);
        let alive = AliveGuard(Arc::clone(&service.writer_alive));
        let writer = Arc::clone(&service);
        let started = std::thread::Builder::new()
            .name("state-writer".to_owned())
            .spawn(move || {
                let _alive = alive;
                writer.write_forever();
            });
        if let Err(error) = started {
            // The closure (and its guard) was dropped: the flag is already false.
            tracing::error!(%error, "N-05: no state writer; changes are saved on quit only");
        }
        service
    }

    /// The service without its writer thread.
    fn load(dir: &Path) -> Self {
        let file = StateFile::in_dir(dir);
        let window_file = WindowFile::in_dir(dir);
        let loaded = file.load();
        if let Some(reason) = &loaded.read_only {
            tracing::warn!(%reason, "N-05: read-only run; changes won't be saved");
        }
        let health = StateHealth {
            read_only: loaded.read_only.as_ref().map(ToString::to_string),
            save_error: None,
            note: loaded.note(),
        };
        Self {
            window: Mutex::new(window_file.load()),
            file,
            window_file,
            read_only: loaded.read_only.is_some(),
            from_fallback: loaded.from_fallback(),
            document: Mutex::new(loaded.document),
            pending: Mutex::default(),
            wake: Condvar::new(),
            saved: Mutex::new(0),
            save_order: Mutex::new(0),
            written: Mutex::new(0),
            frozen: Mutex::default(),
            writer_alive: Arc::new(AtomicBool::new(false)),
            health: Mutex::new(health),
            notify: Notifier(Mutex::new(None)),
        }
    }

    pub(crate) fn document(&self) -> Document {
        lock(&self.document).clone()
    }

    pub(crate) fn read_only(&self) -> bool {
        self.read_only
    }

    /// N-05: the document did not come from a good `workspaces.json` (a fresh start, a backup,
    /// an empty start after a damaged file, an unreadable file): files kept per panel
    /// (scrollback) must not be cleaned up against its panels.
    pub(crate) fn is_fallback(&self) -> bool {
        self.from_fallback
    }

    /// N-05: what the UI shows about saving now.
    pub(crate) fn health(&self) -> StateHealth {
        lock(&self.health).clone()
    }

    /// N-05: `notify` hears every later [`StateHealth`] change (the UI's event). A new call
    /// replaces the previous listener (the page loaded again).
    pub(crate) fn on_health(&self, notify: impl Fn(&StateHealth) + Send + Sync + 'static) {
        *lock(&self.notify.0) = Some(Box::new(notify));
    }

    /// N-05: the UI's new document, kept (normalized) and queued for writing.
    pub(crate) fn save(&self, document: Document) {
        let document = document.normalized();
        *lock(&self.document) = document.clone();
        if self.read_only {
            return;
        }
        let mut frozen = lock(&self.frozen);
        if frozen.on {
            frozen.missed = true;
            return;
        }
        self.queue(document);
        drop(frozen);
        self.wake.notify_all();
    }

    /// Puts `document` in the queue as the newest.
    fn queue(&self, document: Document) {
        let mut saved = lock(&self.saved);
        *saved += 1;
        // Under `saved`, so numbers reach the queue in order.
        lock(&self.pending).document = Some((*saved, document));
    }

    /// N-05: Windows is ending the user's session (`WM_QUERYENDSESSION`), or the app quits:
    /// from now on the documents the UI sends are kept in memory but not written, so the file
    /// keeps the session as it was. Windows may end an agent before its shell; the shell's next
    /// prompt then reports the agent ended, and saving that would keep it from being resumed at
    /// the next start. What was queued before is still written by [`Self::flush`].
    pub(crate) fn freeze(&self) {
        lock(&self.frozen).on = true;
        tracing::info!("N-05: the session is ending; documents are no longer written");
    }

    /// N-05: the end was cancelled (`WM_ENDSESSION` saying no): writing resumes, starting with
    /// the newest document if one came while frozen.
    pub(crate) fn thaw(&self) {
        let mut frozen = lock(&self.frozen);
        if !frozen.on {
            return;
        }
        frozen.on = false;
        tracing::info!("N-05: the session goes on; documents are written again");
        if std::mem::take(&mut frozen.missed) && !self.read_only {
            let document = lock(&self.document).clone();
            self.queue(document);
        }
        drop(frozen);
        self.wake.notify_all();
    }

    /// The page's number of the newest document it saved, held for applying the next one.
    pub(crate) fn save_order(&self) -> MutexGuard<'_, u32> {
        lock(&self.save_order)
    }

    /// A page (re)loads: it numbers its saves from 1 again.
    pub(crate) fn page_loading(&self) {
        *lock(&self.save_order) = 0;
    }

    pub(crate) fn window(&self) -> Option<WindowBounds> {
        lock(&self.window).clone()
    }

    pub(crate) fn set_window(&self, bounds: WindowBounds) {
        if lock(&self.window).as_ref() == Some(&bounds) {
            return;
        }
        *lock(&self.window) = Some(bounds.clone());
        lock(&self.pending).window = Some(bounds);
        self.wake.notify_all();
    }

    /// The IDs of every panel (of any kind) in the document now.
    pub(crate) fn panel_ids(&self) -> HashSet<String> {
        lock(&self.document).panel_ids()
    }

    pub(crate) fn has_panel(&self, id: &str) -> bool {
        lock(&self.document).panels().any(|p| p.id == id)
    }

    /// N-03: the IDs of the terminal panels now, the only ones with sessions.
    pub(crate) fn terminal_ids(&self) -> HashSet<String> {
        lock(&self.document).terminal_ids()
    }

    /// N-03: whether `id` is a terminal panel of the document now.
    pub(crate) fn has_terminal(&self, id: &str) -> bool {
        lock(&self.document)
            .panels()
            .any(|p| p.id == id && p.content.terminal().is_some())
    }

    /// N-05: puts everything queued on disk (on quit). Waits for the writer at most
    /// [`FLUSH_WAIT`], then writes what is left on this thread; never waits on a writer that
    /// is gone. Returns whether everything queued is on disk.
    pub(crate) fn flush(&self) -> bool {
        self.flush_within(FLUSH_WAIT)
    }

    fn flush_within(&self, wait: Duration) -> bool {
        let deadline = Instant::now() + wait;
        let mut pending = lock(&self.pending);
        pending.urgent = true;
        self.wake.notify_all();
        while self.writer_alive.load(Ordering::SeqCst)
            && (pending.writing || pending.document.is_some() || pending.window.is_some())
        {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            pending = self
                .wake
                .wait_timeout(pending, deadline - now)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        let document = pending.document.take();
        let window = pending.window.take();
        // The writer may still be inside a write it took from the queue: not on disk yet.
        let still_writing = pending.writing;
        drop(pending);
        if document.is_none() && window.is_none() {
            return !still_writing;
        }
        tracing::warn!("N-05: the state writer is late or gone; writing on this thread");
        if let Some(window) = window
            && let Err(error) = self.window_file.save(&window)
        {
            tracing::warn!(%error, "N-05: could not save the window bounds");
        }
        let Some((number, document)) = document else {
            return !still_writing;
        };
        // The writer may be stuck inside a write: never wait for it here.
        let written = match self.written.try_lock() {
            Ok(written) => written,
            Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
            Err(TryLockError::WouldBlock) => {
                tracing::error!("N-05: a save is stuck on the disk; the latest change waits");
                self.requeue(number, document);
                return false;
            }
        };
        match self.write_document(written, number, &document) {
            Ok(()) => {
                self.set_save_error(None);
                true
            }
            Err(error) => {
                tracing::error!(%error, "N-05: could not save the workspaces");
                self.requeue(number, document);
                self.set_save_error(Some(error.to_string()));
                false
            }
        }
    }

    /// Puts a document that couldn't be written back in the queue, unless a newer one is there.
    fn requeue(&self, number: u64, document: Document) {
        let mut pending = lock(&self.pending);
        if pending.document.is_none() {
            pending.document = Some((number, document));
        }
        drop(pending);
        self.wake.notify_all();
    }

    /// Writes document `number` unless a newer one is already on disk.
    fn write_document(
        &self,
        mut written: MutexGuard<'_, u64>,
        number: u64,
        document: &Document,
    ) -> std::io::Result<()> {
        if number <= *written {
            return Ok(());
        }
        self.file.save(document)?;
        *written = number;
        Ok(())
    }

    /// Records whether saving fails and tells the UI when that changes.
    fn set_save_error(&self, error: Option<String>) {
        let health = {
            let mut health = lock(&self.health);
            if health.save_error == error {
                return;
            }
            health.save_error = error;
            health.clone()
        };
        if let Some(notify) = lock(&self.notify.0).as_ref() {
            notify(&health);
        }
    }

    fn write_forever(&self) {
        let mut pause: Option<Duration> = None;
        loop {
            let (document, window) = {
                let mut pending = lock(&self.pending);
                // After a failure: wait before trying again, unless `flush` asks.
                if let Some(pause) = pause {
                    let until = Instant::now() + pause;
                    while !pending.urgent {
                        let now = Instant::now();
                        if now >= until {
                            break;
                        }
                        pending = self
                            .wake
                            .wait_timeout(pending, until - now)
                            .unwrap_or_else(PoisonError::into_inner)
                            .0;
                    }
                    pending.urgent = false;
                }
                while pending.document.is_none() && pending.window.is_none() {
                    pending = self
                        .wake
                        .wait(pending)
                        .unwrap_or_else(PoisonError::into_inner);
                }
                pending.writing = true;
                (pending.document.take(), pending.window.take())
            };
            if let Some(window) = window
                && let Err(error) = self.window_file.save(&window)
            {
                tracing::warn!(%error, "N-05: could not save the window bounds");
            }
            let outcome = document.map(|(number, document)| {
                self.write_document(lock(&self.written), number, &document)
                    .map_err(|error| (number, document, error))
            });
            {
                let mut pending = lock(&self.pending);
                if let Some(Err((number, document, _))) = &outcome
                    && pending.document.is_none()
                {
                    // Kept for the next try, unless a newer document replaced it.
                    pending.document = Some((*number, document.clone()));
                }
                pending.writing = false;
            }
            self.wake.notify_all();
            match outcome {
                Some(Ok(())) => {
                    pause = None;
                    self.set_save_error(None);
                }
                Some(Err((_, _, error))) => {
                    tracing::error!(%error, ?pause, "N-05: could not save the workspaces; retrying");
                    pause = Some(pause.map_or(RETRY_FIRST, |p| (p * 2).min(RETRY_MAX)));
                    self.set_save_error(Some(error.to_string()));
                }
                None => {}
            }
        }
    }
}

/// The data folder: `WOLFCMD_DATA_DIR` (tests), else `%APPDATA%\WolfCmd` (release) or
/// `%APPDATA%\WolfCmd-dev` (debug builds, so development never touches the user's workspaces).
pub(crate) fn data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("WOLFCMD_DATA_DIR") {
        return PathBuf::from(dir);
    }
    let base = std::env::var_os("APPDATA").map_or_else(std::env::temp_dir, PathBuf::from);
    base.join(if cfg!(debug_assertions) {
        "WolfCmd-dev"
    } else {
        "WolfCmd"
    })
}

/// ADR-0001: an earlier data folder of a different format
/// (it has `state.db` and no `workspaces.json`) is renamed `<name>.old` (or
/// `<name>.old-<seconds>` when that exists) before WolfCmd uses the folder, so nothing is deleted
/// and the user can put it back. Returns the new name when it moved one.
pub(crate) fn retire_old_data(dir: &Path) -> Option<PathBuf> {
    if !dir.join("state.db").is_file() || dir.join("workspaces.json").exists() {
        return None;
    }
    let name = dir.file_name()?.to_string_lossy().into_owned();
    let mut target = dir.with_file_name(format!("{name}.old"));
    if target.exists() {
        let seconds = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        target = dir.with_file_name(format!("{name}.old-{seconds}"));
    }
    match std::fs::rename(dir, &target) {
        Ok(()) => Some(target),
        Err(error) => {
            tracing::warn!(%error, "ADR-0001: could not set the earlier data folder aside");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wcmd_state::{Layout, Panel, Tab, TerminalContent, Workspace};

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wcmd-app-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn document(panel: &str) -> Document {
        Document {
            version: wcmd_state::CURRENT_VERSION,
            workspaces: vec![Workspace {
                id: "w1".into(),
                name: String::new(),
                folder: None,
                tabs: vec![Tab {
                    id: "t1".into(),
                    name: String::new(),
                    layout: Some(Layout::Panel(Panel::terminal(
                        panel,
                        TerminalContent::default(),
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

    #[test]
    fn n03_only_terminal_panels_have_sessions_and_unknown_kinds_are_kept() {
        let dir = temp_dir("kinds");
        let state = StateService::open(&dir);
        let mut doc = document("term");
        let board: Panel = serde_json::from_value(serde_json::json!({
            "id": "board",
            "content": { "kind": "plugin.board", "cards": [1, 2] }
        }))
        .unwrap();
        doc.workspaces[0].tabs.push(Tab {
            id: "t2".into(),
            name: String::new(),
            layout: Some(Layout::Panel(board)),
            focused: None,
            maximized: None,
        });
        state.save(doc);
        assert!(state.flush());
        assert!(state.has_terminal("term") && !state.has_terminal("board"));
        assert!(state.has_panel("board"));
        assert_eq!(state.terminal_ids(), HashSet::from(["term".to_owned()]));
        assert_eq!(state.panel_ids().len(), 2);
        let saved = std::fs::read_to_string(dir.join("workspaces.json")).unwrap();
        assert!(
            saved.contains("\"cards\""),
            "the unknown kind is saved whole"
        );
    }

    #[test]
    fn n05_every_save_reaches_the_disk_and_the_newest_wins() {
        let dir = temp_dir("save");
        let state = StateService::open(&dir);
        for n in 0..50 {
            state.save(document(&format!("p{n}")));
        }
        assert!(state.flush());
        assert_eq!(StateFile::in_dir(&dir).load().document, document("p49"));
        assert!(state.has_panel("p49"));
        assert!(!state.has_panel("p1"));
        assert!(state.is_fallback(), "the first start had no file");
        assert!(!StateService::load(&dir).is_fallback());
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn wait_until(limit: Duration, done: impl Fn() -> bool) -> bool {
        let until = Instant::now() + limit;
        while Instant::now() < until {
            if done() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        done()
    }

    /// Another program holds `workspaces.json` open without `FILE_SHARE_DELETE`, so it can't be
    /// replaced: the save is retried, the UI hears it, and once the file is free the latest
    /// document is on disk.
    #[cfg(windows)]
    #[test]
    fn n05_a_failed_save_is_retried_until_it_succeeds() {
        use std::os::windows::fs::OpenOptionsExt as _;
        const SHARE_READ_WRITE: u32 = 0x1 | 0x2;
        let dir = temp_dir("retry");
        let state = StateService::open(&dir);
        state.save(document("first"));
        assert!(state.flush());
        let heard = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&heard);
        state.on_health(move |health| lock(&log).push(health.save_error.is_some()));
        let holder = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(SHARE_READ_WRITE)
            .open(dir.join("workspaces.json"))
            .unwrap();
        state.save(document("second"));
        assert!(wait_until(Duration::from_secs(5), || state
            .health()
            .save_error
            .is_some()));
        state.save(document("third"));
        // Quit while it is held: flush gives up after its wait instead of hanging.
        let started = Instant::now();
        assert!(!state.flush_within(Duration::from_millis(300)));
        assert!(started.elapsed() < Duration::from_secs(3));
        // Not lost: back in the queue for the writer.
        drop(holder);
        assert!(wait_until(Duration::from_secs(10), || state
            .health()
            .save_error
            .is_none()));
        assert!(state.flush());
        assert_eq!(StateFile::in_dir(&dir).load().document, document("third"));
        assert_eq!(lock(&heard).first(), Some(&true));
        assert_eq!(lock(&heard).last(), Some(&false));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A file no one may open (no sharing at all) is never overwritten, and the run says why.
    #[cfg(windows)]
    #[test]
    fn n05_an_unreadable_file_is_never_overwritten() {
        use std::os::windows::fs::OpenOptionsExt as _;
        let dir = temp_dir("unreadable");
        let path = dir.join("workspaces.json");
        StateFile::in_dir(&dir).save(&document("mine")).unwrap();
        let before = std::fs::read(&path).unwrap();
        let holder = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .unwrap();
        let state = StateService::open(&dir);
        drop(holder);
        assert!(state.read_only());
        assert!(state.is_fallback());
        assert!(state.health().read_only.is_some());
        state.save(document("other"));
        assert!(state.flush());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn n05_flush_writes_itself_when_the_writer_is_gone() {
        let dir = temp_dir("no-writer");
        // No writer thread at all.
        let state = StateService::load(&dir);
        state.save(document("p1"));
        let started = Instant::now();
        assert!(state.flush_within(Duration::from_secs(30)));
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(StateFile::in_dir(&dir).load().document, document("p1"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn n05_flush_waits_at_most_its_limit_for_a_stuck_writer() {
        let dir = temp_dir("stuck");
        let state = StateService::open(&dir);
        // The writer blocks as if the disk hung inside a write.
        let stuck = lock(&state.written);
        state.save(document("p1"));
        assert!(wait_until(Duration::from_secs(5), || lock(&state.pending).writing));
        state.save(document("p2"));
        let started = Instant::now();
        assert!(!state.flush_within(Duration::from_millis(200)));
        assert!(started.elapsed() < Duration::from_secs(3));
        drop(stuck);
        // Nothing lost: the writer finishes p1, then writes p2 (never p1 over p2).
        assert!(state.flush());
        assert_eq!(StateFile::in_dir(&dir).load().document, document("p2"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A flush that gives up while the writer is still inside its write says so, even with
    /// nothing else queued.
    #[test]
    fn n05_flush_reports_a_write_still_in_progress() {
        let dir = temp_dir("in-progress");
        let state = StateService::open(&dir);
        let stuck = lock(&state.written);
        state.save(document("p1"));
        assert!(wait_until(Duration::from_secs(5), || lock(&state.pending).writing));
        assert!(!state.flush_within(Duration::from_millis(200)));
        drop(stuck);
        assert!(state.flush());
        assert_eq!(StateFile::in_dir(&dir).load().document, document("p1"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Windows ending the session freezes the file: a later document (an agent the shutdown
    /// ended, saved as not running) never lands, so the next start resumes the session as it
    /// was. A cancelled shutdown thaws it and the newest document is written.
    #[test]
    fn n05_a_frozen_state_keeps_the_last_document_on_disk_until_thawed() {
        let dir = temp_dir("frozen");
        let state = StateService::open(&dir);
        state.save(document("before"));
        state.freeze();
        // Queued before the freeze: still written.
        assert!(state.flush());
        assert_eq!(StateFile::in_dir(&dir).load().document, document("before"));
        state.save(document("during"));
        assert!(state.flush());
        assert_eq!(StateFile::in_dir(&dir).load().document, document("before"));
        // Kept in memory meanwhile (the sessions follow the document).
        assert!(state.has_panel("during"));
        state.thaw();
        assert!(state.flush());
        assert_eq!(StateFile::in_dir(&dir).load().document, document("during"));
        state.save(document("after"));
        assert!(state.flush());
        assert_eq!(StateFile::in_dir(&dir).load().document, document("after"));
        // A thaw with nothing missed writes nothing new.
        state.freeze();
        state.thaw();
        assert!(state.flush());
        assert_eq!(StateFile::in_dir(&dir).load().document, document("after"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn adr0001_an_earlier_data_folder_is_set_aside_not_deleted() {
        let root = temp_dir("retire");
        let dir = root.join("WolfCmd");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("state.db"), b"old").unwrap();
        let moved = retire_old_data(&dir).unwrap();
        assert_eq!(moved, root.join("WolfCmd.old"));
        assert!(moved.join("state.db").is_file());
        assert!(!dir.exists());
        // A folder in WolfCmd's own format is left alone.
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("workspaces.json"), b"{}").unwrap();
        assert_eq!(retire_old_data(&dir), None);
        let _ = std::fs::remove_dir_all(&root);
    }
}
