//! In-process session host: one shell per session, four threads each.
//!
//! | Thread | Job |
//! |---|---|
//! | `pty-in-N` | writes queued input, so IPC handlers never block on a full pipe |
//! | `pty-read-N` | reads output (paused by flow control), updates the VT state, forwards it |
//! | `pty-out-N` | batches output per frame and delivers it to the attached view, then the exit |
//! | `pty-wait-N` | waits for the shell to exit, then closes the pseudo console |
//!
//! N-02 attach: a session outlives its view. The view (an xterm in the page) attaches with
//! [`LocalSessionHost::open`]; a reloaded page or a remounted panel attaches again and gets a
//! replay of the VT state, then the output that follows, each byte exactly once (the stream
//! offset `Vt::advanced` splits the two). While no view is attached the output only updates the
//! VT state and the shell never waits. A session ends when its shell exits, its panel leaves the
//! workspace document ([`LocalSessionHost::kill_panels`], or [`ORPHAN_AFTER`] detached without
//! a panel) or the app quits ([`LocalSessionHost::kill_all`]); never because the page went away.

use std::collections::{HashMap, HashSet};
use std::hash::Hash;
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock, PoisonError, RwLock};
use std::thread;
use std::time::{Duration, Instant};

use wcmd_agents::TitlePattern;
use wcmd_pty::{
    Child, Profile, PtySession, PtySize, PtyWriter, SHELL_INTEGRATION_ENV, ShellIntegration,
    ShellKind, default_profile_preferring, find_profile, installed_profiles,
};
use wcmd_term::{Terminal, TerminalSize};

use super::activity::{ActivityWatch, InputMarks};
use super::flow::FlowControl;
use super::input_order::InputOrder;
use super::snapshot_store::{self, PanelCheck, SnapshotStore};
use super::types::{
    AttachmentId, ProfileInfo, PtyAckArgs, PtyDetachArgs, PtyOpenArgs, PtyOpenResult,
    PtyResizeArgs, PtyWriteArgs, SessionId,
};
use super::undo_grace::UndoGrace;
use super::{EventSink, SessionEvent, batcher};
use crate::error::{ErrorKind, WcmdError};

/// Lines kept by the Rust-side VT state. The UI's scrollback is configured separately.
const SCROLLBACK_LINES: usize = 10_000;
/// Read buffer per session; reused for every read (no allocation per byte).
const READ_BUFFER: usize = 64 * 1024;
/// A session detached this long whose panel is not in the document ends (a panel closed while
/// its view was away, e.g. during a reload).
pub(crate) const ORPHAN_AFTER: Duration = Duration::from_secs(30);
/// How often the keeper thread saves quiet sessions and ends orphans.
const KEEPER_TICK: Duration = Duration::from_secs(1);
/// A start folder that doesn't answer this fast (a dead network share) is skipped.
const CWD_CHECK_TIMEOUT: Duration = Duration::from_secs(2);

/// The VT state and where the output stream is.
struct Vt {
    term: Terminal,
    /// Bytes fed so far: the stream offset of the next byte.
    advanced: u64,
    /// N-05: output not in a saved snapshot yet, as (first, last) arrival.
    unsaved: Option<(Instant, Instant)>,
    /// N-03: the folder last reported to the view; the same folder again is not reported.
    reported_cwd: Option<String>,
    /// N-06: the agent typed into the session, if any.
    agent: AgentWatch,
    /// N-06: whether that agent works, while it runs.
    activity: Option<ActivityWatch>,
}

impl Vt {
    fn new(size: PtySize) -> Self {
        Self {
            term: Terminal::new(to_terminal_size(size), SCROLLBACK_LINES),
            advanced: 0,
            unsaved: None,
            reported_cwd: None,
            agent: AgentWatch::None,
            activity: None,
        }
    }

    /// N-06: whether the agent's command has ended (just now, the first time it is seen).
    fn agent_ended_now(&mut self) -> bool {
        match self.agent {
            AgentWatch::Running { typed_at } if self.term.prompts() > typed_at => {
                self.agent = AgentWatch::Exited;
                true
            }
            _ => false,
        }
    }
}

/// N-06: the agent's command, from shell integration's prompt marks: typed at a prompt, it has
/// ended when the shell starts its next one. Shells without integration never mark prompts,
/// so their agent never counts as ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgentWatch {
    None,
    /// The agent's line was typed when the shell had started `typed_at` prompts.
    Running {
        typed_at: u64,
    },
    Exited,
}

/// What the reader found for the view besides output, reported right after the chunk that
/// carried it (kept while no view is attached).
#[derive(Debug, Default)]
struct Reports {
    cwd: Option<String>,
    agent_exited: bool,
}

/// The view a session's output goes to.
struct Attachment {
    id: AttachmentId,
    sink: EventSink,
    /// Output below this stream offset was in the replay the view started with.
    from: u64,
    /// N-01: hidden to the tray, the view fell [`super::flow::HIGH_WATERMARK`] behind: no more
    /// output goes to it until the window shows and it catches up from the screen state
    /// ([`LocalSessionHost::set_background`]).
    behind: bool,
}

#[derive(Default)]
struct View {
    attachment: Option<Attachment>,
    /// When the last view went away; `None` while one is attached.
    detached_at: Option<Instant>,
}

impl View {
    fn detach(&mut self, flow: &FlowControl, now: Instant) {
        self.attachment = None;
        self.detached_at = Some(now);
        flow.reset();
    }
}

struct Entry {
    /// The panel whose session this is, if any (its scrollback is saved under it).
    panel: Option<String>,
    profile_name: String,
    /// The profile the shell runs (the default when the asked one is gone).
    profile_id: String,
    /// Started with shell integration (prompt marks).
    integrated: bool,
    input: Sender<Vec<u8>>,
    /// N-06: when input last reached the shell, and how many submits (lock-free).
    marks: Arc<InputMarks>,
    order: Mutex<InputOrder>,
    control: Mutex<PtySession>,
    vt: Arc<Mutex<Vt>>,
    flow: Arc<FlowControl>,
    view: Arc<Mutex<View>>,
}

type Sessions = Arc<RwLock<HashMap<SessionId, Arc<Entry>>>>;

/// N-06: hears that a panel's agent started or stopped working (`panel`, `working`).
pub(crate) type ActivitySink = Box<dyn Fn(&str, bool) + Send + Sync>;
/// N-06: an agent's `working_title` by its id (the agent registry).
pub(crate) type TitlePatterns = Box<dyn Fn(&str) -> Option<TitlePattern> + Send + Sync>;
/// N-07: the user's default shell (`terminal.default_profile`), read at each spawn.
pub(crate) type DefaultChoice = Box<dyn Fn() -> Option<String> + Send + Sync>;

/// N-06: where a session's activity changes go.
struct ActivityOut {
    panel: Option<String>,
    sink: Arc<OnceLock<ActivitySink>>,
    marks: Arc<InputMarks>,
}

impl ActivityOut {
    fn report(&self, working: Option<bool>) {
        if let (Some(working), Some(panel), Some(sink)) = (working, &self.panel, self.sink.get()) {
            sink(panel, working);
        }
    }
}

/// Opens in progress and their results.
#[derive(Default)]
struct Opening {
    /// Request IDs (`r:`) and panel IDs (`p:`) with an open in progress: a repeated request or
    /// a second open of the panel waits for it instead of starting a second shell.
    busy: HashSet<String>,
    /// Results by request ID, so a repeated call gets the same answer (until the session ends).
    done: HashMap<String, PtyOpenResult>,
}

#[derive(Default)]
pub(crate) struct LocalSessionHost {
    next_id: AtomicU32,
    next_attachment: AtomicU32,
    sessions: Sessions,
    opening: Arc<Mutex<Opening>>,
    opened: Condvar,
    /// Bumped on every page load; an open that started under an older page leaves its session
    /// detached.
    page: AtomicU64,
    /// How built-in shells are started so they report folders and command marks.
    integration: ShellIntegration,
    /// Where scrollback snapshots are kept; `None` (tests, benchmarks): not kept.
    snapshots: Option<Arc<SnapshotStore>>,
    /// Whether a panel is in the workspace document; `None`: every panel is.
    panels: Option<PanelCheck>,
    /// N-06: where agent activity changes go (set once the window exists).
    activity: Arc<OnceLock<ActivitySink>>,
    /// N-06: agents' title patterns; `None`: output activity only.
    titles: Option<TitlePatterns>,
    /// N-07: the default shell setting; `None`: automatic.
    default_choice: Option<DefaultChoice>,
    /// N-01: the window is hidden to the tray ([`Self::set_background`]).
    background: AtomicBool,
    /// N-11: closed panels whose sessions wait for an undo ([`Self::close_panels`]).
    grace: Arc<UndoGrace>,
}

impl std::fmt::Debug for LocalSessionHost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LocalSessionHost").finish_non_exhaustive()
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // A panic on another thread must not take the terminal down with it.
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn to_terminal_size(size: PtySize) -> TerminalSize {
    TerminalSize {
        cols: size.cols,
        rows: size.rows,
    }
}

fn spawn_thread(name: String, f: impl FnOnce() + Send + 'static) -> Result<(), WcmdError> {
    thread::Builder::new()
        .name(name)
        .spawn(f)
        .map(drop)
        .map_err(|e| WcmdError::internal("could not start a session thread", &e))
}

/// N-05: whether unsaved output is due for a snapshot: the session has been quiet for
/// `SAVE_WHEN_QUIET`, or its first unsaved output is `SAVE_AT_LATEST` old.
pub(crate) fn save_due(first: Instant, last: Instant, now: Instant) -> bool {
    now.saturating_duration_since(last) >= snapshot_store::SAVE_WHEN_QUIET
        || now.saturating_duration_since(first) >= snapshot_store::SAVE_AT_LATEST
}

/// The answer of `check` (run on its own thread), or `None` when it takes longer than
/// `timeout`. The thread is left to finish on its own.
fn answer_within(check: impl FnOnce() -> bool + Send + 'static, timeout: Duration) -> Option<bool> {
    let (tx, rx) = mpsc::sync_channel(1);
    thread::Builder::new()
        .name("cwd-check".to_owned())
        .spawn(move || {
            let _ = tx.send(check());
        })
        .ok()?;
    rx.recv_timeout(timeout).ok()
}

/// N-02: the start folder, if it exists. A restored folder may be gone (or a WSL path), and a
/// network share may hang: the shell then starts in its default folder.
fn start_folder(dir: &str) -> Option<PathBuf> {
    let path = PathBuf::from(dir);
    let probe = path.clone();
    match answer_within(move || probe.is_dir(), CWD_CHECK_TIMEOUT) {
        Some(true) => Some(path),
        Some(false) => None,
        None => {
            tracing::warn!("N-02: the start folder did not answer in time; using the default");
            None
        }
    }
}

/// Removes `key` and returns its value with the map's lock already released, so dropping the
/// value (closing a pseudo console waits for its output to drain) never blocks other users.
fn take_out<K: Eq + Hash, V>(map: &RwLock<HashMap<K, V>>, key: &K) -> Option<V> {
    map.write()
        .unwrap_or_else(PoisonError::into_inner)
        .remove(key)
}

/// Clears a request's and a panel's busy marks when an open ends (also by an error or a panic).
struct Busy<'a> {
    host: &'a LocalSessionHost,
    keys: Vec<String>,
}

impl Drop for Busy<'_> {
    fn drop(&mut self) {
        let mut opening = lock(&self.host.opening);
        for key in &self.keys {
            opening.busy.remove(key);
        }
        drop(opening);
        self.host.opened.notify_all();
    }
}

impl LocalSessionHost {
    pub(crate) fn new(integration: ShellIntegration) -> Self {
        Self {
            integration,
            ..Self::default()
        }
    }

    /// Keeps each terminal's scrollback in `store` and shows it again (dim, above a divider)
    /// when the panel's next session starts. Saving runs on the keeper ([`Self::start_keeper`]).
    #[must_use]
    pub(crate) fn with_snapshots(mut self, store: SnapshotStore) -> Self {
        self.snapshots = Some(Arc::new(store));
        self
    }

    /// Tells the host which panels are in the workspace document, so the keeper can end the
    /// sessions of panels that are gone.
    #[must_use]
    pub(crate) fn with_panels(mut self, check: PanelCheck) -> Self {
        self.panels = Some(check);
        self
    }

    /// N-11: the closed panels waiting for an undo, shared with the scrollback store (their
    /// scrollback is saved while they wait).
    #[must_use]
    pub(crate) fn with_undo_grace(mut self, grace: Arc<UndoGrace>) -> Self {
        self.grace = grace;
        self
    }

    /// N-06: agents' `working_title` patterns, looked up by agent id when an agent starts.
    #[must_use]
    pub(crate) fn with_title_patterns(mut self, titles: TitlePatterns) -> Self {
        self.titles = Some(titles);
        self
    }

    /// N-07: the default shell setting, asked whenever a terminal starts without a profile.
    #[must_use]
    pub(crate) fn with_default_profile(mut self, choice: DefaultChoice) -> Self {
        self.default_choice = Some(choice);
        self
    }

    /// N-07: the shell a terminal without a profile runs: `WOLFCMD_DEFAULT_PROFILE`, else the
    /// setting (when installed), else the first installed shell.
    pub(crate) fn default_profile(&self) -> Profile {
        let chosen = self.default_choice.as_ref().and_then(|choice| choice());
        default_profile_preferring(chosen.as_deref())
    }

    /// N-06: where each agent panel's working / idle changes go (once; later calls are ignored).
    pub(crate) fn on_activity(&self, sink: ActivitySink) {
        let _ = self.activity.set(sink);
    }

    /// Starts the `session-keeper` thread: it first removes the snapshots of panels that are
    /// gone, then every [`KEEPER_TICK`] saves the scrollback of sessions that went quiet
    /// ([`save_due`]) and ends orphaned sessions ([`ORPHAN_AFTER`]). It stops with the host.
    pub(crate) fn start_keeper(self: &Arc<Self>) {
        let host = Arc::downgrade(self);
        let started = thread::Builder::new()
            .name("session-keeper".to_owned())
            .spawn(move || {
                if let Some(store) = host.upgrade().and_then(|h| h.snapshots.clone()) {
                    store.clean_up();
                }
                loop {
                    thread::sleep(KEEPER_TICK);
                    let Some(host) = host.upgrade() else {
                        return;
                    };
                    let now = Instant::now();
                    host.save_quiet(now);
                    host.sweep(now);
                    host.tick_activity(now);
                }
            });
        if let Err(error) = started {
            tracing::warn!(%error, "scrollback is saved only when sessions end and on quit");
        }
    }

    /// The panel's last scrollback, dim above a divider, as the session's first output:
    /// before anything the shell writes (ConPTY inherits the cursor below it). Fed to the VT
    /// state too, so a replay and the next snapshot still have it.
    fn restore(&self, panel_id: Option<&str>, vt: &Mutex<Vt>, output: &Sender<Vec<u8>>) {
        if let (Some(store), Some(panel)) = (&self.snapshots, panel_id)
            && let Some(restored) = store.take_restore(panel)
        {
            let mut vt = lock(vt);
            vt.term.advance(&restored);
            vt.advanced += restored.len() as u64;
            drop(vt);
            let _ = output.send(restored);
        }
    }

    /// The profile for a spawn. A saved panel can name a profile that is
    /// gone (shell uninstalled, or the launch program of an earlier run); it gets the
    /// default shell instead of failing.
    fn resolve_profile(&self, id: Option<&str>) -> Profile {
        match id {
            None => self.default_profile(),
            Some(id) => find_profile(id).unwrap_or_else(|| {
                tracing::warn!(profile = id, "shell profile not found; using the default");
                self.default_profile()
            }),
        }
    }

    fn entry(&self, id: SessionId) -> Result<Arc<Entry>, WcmdError> {
        self.sessions
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&id)
            .cloned()
            .ok_or_else(|| {
                WcmdError::new(ErrorKind::NotFound, format!("session {} has ended", id.0))
            })
    }

    fn entries(&self) -> Vec<(SessionId, Arc<Entry>)> {
        self.sessions
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .map(|(id, entry)| (*id, Arc::clone(entry)))
            .collect()
    }

    /// The running session of a panel.
    fn session_of(&self, panel: &str) -> Option<(SessionId, Arc<Entry>)> {
        self.entries()
            .into_iter()
            .find(|(_, entry)| entry.panel.as_deref() == Some(panel))
    }

    /// Whether `panel` is in the workspace document.
    fn in_document(&self, panel: &str) -> bool {
        self.panels.as_ref().is_none_or(|check| check(panel))
    }

    /// Whether `panel`'s session is wanted: its panel is in the document, or N-11 it was closed
    /// and an undo can still bring it back.
    fn is_panel(&self, panel: &str) -> bool {
        self.in_document(panel) || self.grace.holds(panel)
    }

    fn new_attachment(&self) -> AttachmentId {
        AttachmentId(self.next_attachment.fetch_add(1, Ordering::Relaxed) + 1)
    }
}

impl LocalSessionHost {
    /// N-02: connects a view to the panel's running session (a replay first, then its output),
    /// or starts a shell for it. Events go to `sink` until the view detaches, another view
    /// attaches, or the session exits. One shell per panel: a second open of a panel waits for
    /// the first and then attaches.
    pub(crate) fn open(
        &self,
        args: PtyOpenArgs,
        sink: EventSink,
    ) -> Result<PtyOpenResult, WcmdError> {
        let page = self.page.load(Ordering::SeqCst);
        let mut keys = vec![format!("r:{}", args.request_id)];
        keys.extend(args.panel_id.as_ref().map(|panel| format!("p:{panel}")));
        {
            let mut opening = lock(&self.opening);
            loop {
                if let Some(done) = opening.done.get(&args.request_id) {
                    tracing::debug!(session = done.session_id.0, "repeated open ignored");
                    return Ok(done.clone());
                }
                if !keys.iter().any(|key| opening.busy.contains(key)) {
                    break;
                }
                opening = self
                    .opened
                    .wait(opening)
                    .unwrap_or_else(PoisonError::into_inner);
            }
            opening.busy.extend(keys.iter().cloned());
        }
        let _busy = Busy { host: self, keys };

        let running = args.panel_id.as_deref().and_then(|p| self.session_of(p));
        let result = match running {
            Some((id, entry)) => self.attach(id, &entry, args.size, sink),
            None => self.start(&args, sink)?,
        };
        // The page that asked was reloaded meanwhile: nobody shows this view.
        if self.page.load(Ordering::SeqCst) != page {
            tracing::debug!(session = result.session_id.0, "opened for a reloaded page");
            self.detach(PtyDetachArgs {
                session_id: result.session_id,
                attachment: result.attachment,
            });
        }
        lock(&self.opening)
            .done
            .insert(args.request_id, result.clone());
        Ok(result)
    }

    /// Attaches `sink` to a running session: under the VT lock, its replay goes out first and
    /// the output from that point on follows (nothing twice, nothing missing).
    fn attach(
        &self,
        id: SessionId,
        entry: &Entry,
        size: PtySize,
        mut sink: EventSink,
    ) -> PtyOpenResult {
        let attachment = self.new_attachment();
        // The new view's size first, so the replay fits it.
        if to_terminal_size(size) != lock(&entry.vt).term.size() {
            if let Err(error) = lock(&entry.control).resize(size) {
                tracing::warn!(%error, "could not resize a reattached terminal");
            }
            lock(&entry.vt).term.resize(to_terminal_size(size));
        }
        let mut vt = lock(&entry.vt);
        let replay = vt.term.replay();
        let from = vt.advanced;
        let agent_exited = vt.agent == AgentWatch::Exited;
        let agent_working = vt.activity.as_ref().is_some_and(ActivityWatch::working);
        let mut view = lock(&entry.view);
        lock(&entry.order).restart(attachment);
        entry.flow.reset();
        entry.flow.sent(replay.len());
        // A failed send means the view is gone already; the next delivery finds that out.
        let _ = sink(SessionEvent::Output(replay));
        view.attachment = Some(Attachment {
            id: attachment,
            sink,
            from,
            behind: false,
        });
        view.detached_at = None;
        drop(view);
        drop(vt);
        tracing::info!(session = id.0, "terminal session reattached");
        PtyOpenResult {
            session_id: id,
            profile_name: entry.profile_name.clone(),
            profile_id: entry.profile_id.clone(),
            integrated: entry.integrated,
            agent_exited,
            agent_working,
            attachment,
            attached: true,
        }
    }

    /// Starts a shell with `sink` attached from its first byte.
    fn start(&self, args: &PtyOpenArgs, sink: EventSink) -> Result<PtyOpenResult, WcmdError> {
        let profile = self.resolve_profile(args.profile_id.as_deref());
        let launch = self.integration.apply(&profile);
        // N-06: integrated shells surely mark their prompts. Not WSL: its launcher starts a shell
        // other than bash, zsh or fish without integration.
        let integrated = profile.shell != Some(ShellKind::Wsl)
            && launch
                .env
                .iter()
                .any(|(name, value)| name == SHELL_INTEGRATION_ENV && value == "1");
        let cwd = args.cwd.as_deref().and_then(start_folder);
        let spawned = PtySession::spawn(&launch, args.size, cwd.as_deref())
            .map_err(|e| WcmdError::new(ErrorKind::Unavailable, e.to_string()))?;

        let id = SessionId(self.next_id.fetch_add(1, Ordering::Relaxed));
        let attachment = self.new_attachment();
        let vt = Arc::new(Mutex::new(Vt::new(args.size)));
        let marks = Arc::new(InputMarks::new(Instant::now()));
        let (input_tx, input_rx) = mpsc::channel();
        let (output_tx, output_rx) = mpsc::channel();
        let (exit_tx, exit_rx) = mpsc::channel();
        let flow = Arc::new(FlowControl::default());
        let reports = Arc::new(Mutex::new(Reports::default()));
        let view = Arc::new(Mutex::new(View {
            attachment: Some(Attachment {
                id: attachment,
                sink,
                from: 0,
                behind: false,
            }),
            detached_at: None,
        }));
        self.restore(args.panel_id.as_deref(), &vt, &output_tx);

        self.sessions
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(
                id,
                Arc::new(Entry {
                    panel: args.panel_id.clone(),
                    profile_name: profile.name.clone(),
                    profile_id: profile.id.clone(),
                    integrated,
                    input: input_tx,
                    marks: Arc::clone(&marks),
                    order: Mutex::new(InputOrder::new(attachment)),
                    control: Mutex::new(spawned.session),
                    vt: Arc::clone(&vt),
                    flow: Arc::clone(&flow),
                    view: Arc::clone(&view),
                }),
            );
        // N-01: a shell started while the window is hidden never waits for the page either
        // (read after the insert, so a hide meanwhile reaches it one way or the other).
        flow.set_background(self.background.load(Ordering::SeqCst));

        let n = id.0;
        spawn_thread(format!("pty-in-{n}"), move || {
            write_input(spawned.writer, &input_rx);
        })?;
        let reader_flow = Arc::clone(&flow);
        let reader_reports = Arc::clone(&reports);
        let final_save = self.snapshots.clone().zip(args.panel_id.clone());
        let activity = ActivityOut {
            panel: args.panel_id.clone(),
            sink: Arc::clone(&self.activity),
            marks,
        };
        spawn_thread(format!("pty-read-{n}"), move || {
            read_output(
                spawned.reader,
                &vt,
                &reader_flow,
                &reader_reports,
                &output_tx,
                &activity,
            );
            save_at_end(final_save, &vt);
        })?;
        let output_flow = Arc::clone(&flow);
        spawn_thread(format!("pty-out-{n}"), move || {
            deliver(&output_rx, &exit_rx, &output_flow, &reports, &view);
        })?;
        let sessions = Arc::clone(&self.sessions);
        let opening = Arc::clone(&self.opening);
        spawn_thread(format!("pty-wait-{n}"), move || {
            wait_for_exit(spawned.child, id, &sessions, &flow, &exit_tx);
            lock(&opening).done.retain(|_, done| done.session_id != id);
        })?;

        tracing::info!(session = n, profile = %profile.id, integrated, "terminal session started");
        Ok(PtyOpenResult {
            session_id: id,
            profile_name: profile.name,
            profile_id: profile.id,
            integrated,
            agent_exited: false,
            agent_working: false,
            attachment,
            attached: false,
        })
    }

    /// N-02: the view is gone; the session keeps running. Nothing when another view has
    /// attached since (a late detach from a remounted panel) or the session has ended.
    pub(crate) fn detach(&self, args: PtyDetachArgs) {
        let Ok(entry) = self.entry(args.session_id) else {
            return;
        };
        let mut view = lock(&entry.view);
        if view
            .attachment
            .as_ref()
            .is_some_and(|a| a.id == args.attachment)
        {
            view.detach(&entry.flow, Instant::now());
            tracing::debug!(session = args.session_id.0, "terminal session detached");
        }
    }

    /// N-02: the page (re)loads: every view is gone, every session keeps running, and each
    /// panel's next new shell shows its saved scrollback again.
    pub(crate) fn detach_all(&self) {
        self.page.fetch_add(1, Ordering::SeqCst);
        if let Some(store) = &self.snapshots {
            store.new_page();
        }
        let now = Instant::now();
        for (_, entry) in self.entries() {
            let mut view = lock(&entry.view);
            if view.attachment.is_some() {
                view.detach(&entry.flow, now);
            }
        }
    }

    /// N-01: the window is hidden to the tray (`true`) or shown again. Hidden, no session waits
    /// for its view's acknowledgements (a hidden page is throttled: an agent left in the tray must
    /// never stall), like a session without a view; output still goes to the view until it is
    /// [`super::flow::HIGH_WATERMARK`] behind, then nothing more (the backlog stays bounded).
    /// Shown again, a view that fell behind catches up from the core's screen state: a full
    /// reset and the replay a reattach gets, after which the stream goes on from the replay's
    /// offset, so every byte still reaches it exactly once.
    pub(crate) fn set_background(&self, on: bool) {
        self.background.store(on, Ordering::SeqCst);
        let now = Instant::now();
        for (id, entry) in self.entries() {
            entry.flow.set_background(on);
            if !on {
                catch_up(id, &entry, now);
            }
        }
    }

    /// N-02: queues input for the shell, in the order it was typed. Never blocks.
    pub(crate) fn write(&self, args: PtyWriteArgs) -> Result<(), WcmdError> {
        let entry = self.entry(args.session_id)?;
        let now = Instant::now();
        if let Some(agent) = &args.agent {
            // N-06: typed at the current prompt; the next prompt means the agent ended, and
            // until then its activity is watched. (Before `order`: the VT lock is never taken
            // under it.)
            let pattern = self.titles.as_ref().and_then(|titles| titles(agent));
            let mut vt = lock(&entry.vt);
            vt.agent = AgentWatch::Running {
                typed_at: vt.term.prompts(),
            };
            vt.activity = Some(ActivityWatch::new(pattern, entry.marks.seen()));
            drop(vt);
            entry.marks.input(now, None);
        } else {
            entry.marks.input(now, Some(args.data.as_bytes()));
        }
        let mut order = lock(&entry.order);
        for bytes in order.accept(args.attachment, args.seq, args.data.into_bytes(), now) {
            entry.input.send(bytes).map_err(|_| {
                WcmdError::new(
                    ErrorKind::NotFound,
                    format!("session {} has ended", args.session_id.0),
                )
            })?;
        }
        Ok(())
    }

    pub(crate) fn resize(&self, args: PtyResizeArgs) -> Result<(), WcmdError> {
        let entry = self.entry(args.session_id)?;
        // N-06: a program redraws after a resize; that output is not work.
        entry.marks.input(Instant::now(), None);
        lock(&entry.control)
            .resize(args.size)
            .map_err(|e| WcmdError::new(ErrorKind::Unavailable, e.to_string()))?;
        lock(&entry.vt).term.resize(to_terminal_size(args.size));
        Ok(())
    }

    /// N-02: the shells this machine has, default first.
    pub(crate) fn profiles(&self) -> Vec<ProfileInfo> {
        let default = self.default_profile();
        installed_profiles()
            .iter()
            .cloned()
            .map(|p| ProfileInfo {
                is_default: p.id == default.id,
                id: p.id,
                name: p.name,
                icon: p.icon,
            })
            .collect()
    }

    /// The view has processed `bytes` of output; lets a paused reader continue. An older
    /// view's acks don't count.
    pub(crate) fn ack(&self, args: PtyAckArgs) -> Result<(), WcmdError> {
        let entry = self.entry(args.session_id)?;
        let current = lock(&entry.view)
            .attachment
            .as_ref()
            .is_some_and(|a| a.id == args.attachment);
        if current {
            entry
                .flow
                .ack(usize::try_from(args.bytes).unwrap_or(usize::MAX));
        }
        Ok(())
    }

    /// N-11: after a save, the panels that left the document (`closed`): those the UI's undo
    /// history can still bring back (`undoable`) keep their sessions for the undo grace; the
    /// others end now, as do waiting ones the history dropped. `present`: whether a panel is in
    /// the document now (one brought back by an undo is simply a panel again).
    pub(crate) fn close_panels(
        &self,
        closed: &HashSet<String>,
        present: impl Fn(&str) -> bool,
        undoable: &HashSet<String>,
        now: Instant,
    ) {
        let ending = self.grace.settle(closed, present, undoable, now);
        self.kill_panels(&ending);
    }

    /// N-11: how many panels of the document run an agent now (its line typed, not ended). A
    /// closed panel waiting for an undo doesn't count.
    pub(crate) fn running_agents(&self) -> usize {
        self.entries()
            .iter()
            .filter(|(_, entry)| {
                entry.panel.as_deref().is_some_and(|p| self.in_document(p))
                    && matches!(lock(&entry.vt).agent, AgentWatch::Running { .. })
            })
            .count()
    }

    /// N-02: ends the sessions of panels that left the workspace document (closed).
    pub(crate) fn kill_panels(&self, removed: &HashSet<String>) {
        if removed.is_empty() {
            return;
        }
        for (id, entry) in self.entries() {
            if entry.panel.as_ref().is_some_and(|p| removed.contains(p)) {
                end(id, &entry);
            }
        }
    }

    /// N-10: ends the sessions of `panels` and waits (at most `wait`) until each is gone, its
    /// pseudo console closed: Windows can't delete a folder a shell stands in. Whether all
    /// ended in time. Blocking: call it off the UI thread.
    pub(crate) fn end_panels(&self, panels: &HashSet<String>, wait: Duration) -> bool {
        let ending: Vec<_> = self
            .entries()
            .into_iter()
            .filter(|(_, entry)| entry.panel.as_ref().is_some_and(|p| panels.contains(p)))
            .map(|(id, entry)| {
                end(id, &entry);
                Arc::downgrade(&entry)
            })
            .collect();
        let deadline = Instant::now() + wait;
        while ending.iter().any(|entry| entry.strong_count() > 0) {
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(Duration::from_millis(20));
        }
        true
    }

    /// Ends every session (on quit).
    pub(crate) fn kill_all(&self) {
        for (id, entry) in self.entries() {
            end(id, &entry);
        }
    }

    /// N-02: ends the sessions detached for [`ORPHAN_AFTER`] whose panel is not in the
    /// document (or that have no panel: nobody can attach to them). N-11: and those of closed
    /// panels whose undo grace is over, their scrollback saved first, so a later undo shows it
    /// above a new shell as a restart would.
    pub(crate) fn sweep(&self, now: Instant) {
        let expired = self.grace.expired(now);
        if !expired.is_empty() {
            if let Some(store) = &self.snapshots {
                for panel in &expired {
                    if let Some((_, entry)) = self.session_of(panel) {
                        stage(store, panel, &entry.vt);
                    }
                }
                store.write_staged();
            }
            let released = self.grace.release(&expired, now);
            if let Some(store) = &self.snapshots {
                for panel in &released {
                    store.restore_again(panel);
                }
            }
            let ending: HashSet<String> = released
                .into_iter()
                .filter(|panel| !self.is_panel(panel))
                .collect();
            if !ending.is_empty() {
                tracing::info!(
                    panels = ending.len(),
                    "N-11: the undo grace is over; ending closed panels' sessions"
                );
            }
            self.kill_panels(&ending);
        }
        for (id, entry) in self.entries() {
            let orphaned = {
                let view = lock(&entry.view);
                view.attachment.is_none()
                    && view
                        .detached_at
                        .is_some_and(|at| now.saturating_duration_since(at) >= ORPHAN_AFTER)
            };
            if orphaned && entry.panel.as_deref().is_none_or(|p| !self.is_panel(p)) {
                tracing::info!(
                    session = id.0,
                    "N-02: the panel is gone; ending its session"
                );
                end(id, &entry);
            }
        }
    }

    /// N-05: saves the scrollback of the sessions whose output is due ([`save_due`]).
    pub(crate) fn save_quiet(&self, now: Instant) {
        let Some(store) = &self.snapshots else {
            return;
        };
        let mut staged = false;
        for (_, entry) in self.entries() {
            let Some(panel) = &entry.panel else {
                continue;
            };
            let due = lock(&entry.vt)
                .unsaved
                .is_some_and(|(first, last)| save_due(first, last, now));
            if due {
                stage(store, panel, &entry.vt);
                staged = true;
            }
        }
        if staged {
            store.write_staged();
        }
    }

    /// N-06: a working agent that went quiet waits again (the keeper's tick; nothing to do while
    /// every agent is idle).
    pub(crate) fn tick_activity(&self, now: Instant) {
        for (_, entry) in self.entries() {
            let change = lock(&entry.vt)
                .activity
                .as_mut()
                .and_then(|watch| watch.tick(now));
            if let (Some(working), Some(panel), Some(sink)) =
                (change, &entry.panel, self.activity.get())
            {
                sink(panel, working);
            }
        }
    }

    /// N-05: saves the scrollback of every session whose output changed since its last save,
    /// now (on quit and when Windows ends the session). Blocks until written.
    pub(crate) fn flush_snapshots(&self) {
        if let Some(store) = &self.snapshots {
            for (_, entry) in self.entries() {
                if let Some(panel) = &entry.panel {
                    stage(store, panel, &entry.vt);
                }
            }
            store.write_staged();
        }
    }
}

fn end(id: SessionId, entry: &Entry) {
    tracing::info!(session = id.0, "ending terminal session");
    lock(&entry.control).kill();
}

/// Stages the session's snapshot if its output changed. The bytes are copied and staged under
/// the terminal's lock (a few milliseconds for 2,000 rows) and written later without it: two
/// stagers of one session (the keeper, its reader at the end, the quit) stage their copies in
/// the order they took them, and one that finds nothing changed finds the other's copy already
/// staged (or being written). Nothing while a full-screen program is on the alternate screen:
/// the last main-screen snapshot stays.
fn stage(store: &SnapshotStore, panel: &str, vt: &Mutex<Vt>) {
    let mut vt = lock(vt);
    vt.unsaved = None;
    if !vt.term.take_changed() {
        return;
    }
    if let Some(body) = vt.term.snapshot(true) {
        // N-05: under the terminal's lock (the staged map's lock is innermost).
        store.stage(panel, snapshot_store::now(), body);
    }
}

/// The session ended (its shell exited, its panel closed, or a quit): what it showed last is
/// kept, written from its reader thread.
fn save_at_end(save: Option<(Arc<SnapshotStore>, String)>, vt: &Mutex<Vt>) {
    if let Some((store, panel)) = save {
        stage(&store, &panel, vt);
        store.write_staged();
    }
}

fn write_input(mut writer: PtyWriter, input: &Receiver<Vec<u8>>) {
    for bytes in input {
        if let Err(error) = writer.write(&bytes) {
            tracing::debug!(%error, "input pipe closed");
            return;
        }
    }
}

fn read_output(
    mut reader: Box<dyn Read + Send>,
    vt: &Mutex<Vt>,
    flow: &FlowControl,
    reports: &Mutex<Reports>,
    output: &Sender<Vec<u8>>,
    activity: &ActivityOut,
) {
    let mut buf = vec![0u8; READ_BUFFER];
    loop {
        // Backpressure: while the view is behind, leave output in ConPTY so the shell waits.
        flow.wait_for_capacity();
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                let chunk = &buf[..n];
                let now = Instant::now();
                let mut vt = lock(vt);
                vt.term.advance(chunk);
                vt.advanced += n as u64;
                match &mut vt.unsaved {
                    Some((_, last)) => *last = now,
                    None => vt.unsaved = Some((now, now)),
                }
                // Set before the chunk is sent, so `deliver` reports it right after it. N-03:
                // shells report their folder at every prompt; only a change goes to the view.
                if let Some(dir) = vt.term.take_cwd()
                    && vt.reported_cwd.as_ref() != Some(&dir)
                {
                    vt.reported_cwd = Some(dir.clone());
                    lock(reports).cwd = Some(dir);
                }
                // N-06: the agent's title, then the output itself (a few comparisons per chunk).
                let mut change = None;
                let state = &mut *vt;
                if let Some(watch) = state.activity.as_mut() {
                    if let Some(title) = state.term.take_title() {
                        change = watch.title(&title);
                    }
                    change = watch.output(now, activity.marks.seen()).or(change);
                }
                if vt.agent_ended_now() {
                    lock(reports).agent_exited = true;
                    change = vt
                        .activity
                        .take()
                        .and_then(|mut watch| watch.ended())
                        .or(change);
                }
                drop(vt);
                activity.report(change);
                // Sent in the order fed (one reader), so `deliver` can count stream offsets.
                if output.send(chunk.to_vec()).is_err() {
                    return;
                }
            }
        }
    }
}

/// Output first, then the exit, on one ordered stream to whichever view is attached. While
/// none is, output is dropped here (the VT state has it) and never counts against flow control.
fn deliver(
    output: &Receiver<Vec<u8>>,
    exit: &Receiver<Option<u32>>,
    flow: &FlowControl,
    reports: &Mutex<Reports>,
    view: &Mutex<View>,
) {
    let mut offset: u64 = 0;
    batcher::run(output, batcher::FRAME, |batch| {
        let start = offset;
        offset += batch.len() as u64;
        let mut view = lock(view);
        let Some(attached) = view.attachment.as_mut() else {
            return true;
        };
        // The part the view's replay already showed.
        let skip = usize::try_from(attached.from.saturating_sub(start))
            .unwrap_or(usize::MAX)
            .min(batch.len());
        let bytes = if skip == 0 {
            batch
        } else {
            batch[skip..].to_vec()
        };
        // N-01: hidden to the tray, a view this far behind gets nothing more until the window
        // shows and it catches up from the screen state (`catch_up`).
        if !bytes.is_empty() && !attached.behind && !flow.may_send() {
            attached.behind = true;
            tracing::debug!("N-01: a hidden view fell behind; it catches up when shown");
        }
        let mut listening = true;
        if !bytes.is_empty() && !attached.behind {
            flow.sent(bytes.len());
            listening = (attached.sink)(SessionEvent::Output(bytes));
        }
        if listening {
            let (dir, agent_exited) = {
                let mut reports = lock(reports);
                (
                    reports.cwd.take(),
                    std::mem::take(&mut reports.agent_exited),
                )
            };
            if let Some(dir) = dir {
                listening = (attached.sink)(SessionEvent::Cwd(dir));
            }
            if agent_exited && listening {
                listening = (attached.sink)(SessionEvent::AgentExited);
            }
        }
        if !listening {
            view.detach(flow, Instant::now());
        }
        true
    });
    // No more acks are coming (output ended): never pause the reader again.
    flow.close();
    if let Ok(code) = exit.recv()
        && let Some(attached) = lock(view).attachment.as_mut()
    {
        (attached.sink)(SessionEvent::Exited { code });
    }
}

/// N-01: the window shows again: a view that fell behind while hidden gets a full reset (RIS)
/// and the replay of the screen state, and the stream goes on from that offset (under the VT
/// lock, like an attach: nothing twice, nothing missing). What it was sent before still comes
/// first (the channel keeps its order).
fn catch_up(id: SessionId, entry: &Entry, now: Instant) {
    let mut vt = lock(&entry.vt);
    let mut view = lock(&entry.view);
    let Some(attached) = view.attachment.as_mut().filter(|a| a.behind) else {
        return;
    };
    let mut replay = RESET.to_vec();
    replay.extend(vt.term.replay());
    attached.from = vt.advanced;
    attached.behind = false;
    entry.flow.reset();
    entry.flow.sent(replay.len());
    let listening = (attached.sink)(SessionEvent::Output(replay));
    drop(vt);
    if listening {
        tracing::info!(
            session = id.0,
            "N-01: a view caught up from the screen state"
        );
    } else {
        view.detach(&entry.flow, now);
    }
}

/// N-01: a full reset (RIS): the view starts over like a fresh emulator before a catch-up replay.
const RESET: &[u8] = b"\x1bc";

fn wait_for_exit(
    mut child: Box<dyn Child + Send + Sync>,
    id: SessionId,
    sessions: &Sessions,
    flow: &FlowControl,
    exit: &Sender<Option<u32>>,
) {
    let code = child.wait().ok().map(|status| status.exit_code());
    tracing::info!(session = id.0, ?code, "terminal session exited");
    // Drain the rest without waiting for acks: closing the console must not wait on a view
    // that may be gone.
    flow.close();
    let entry = take_out(sessions, &id);
    let _ = exit.send(code);
    // Closing the pseudo console ends the reader with EOF; the output thread then flushes and
    // reports the exit. Done after the sessions lock is released: it waits for the output to
    // drain, and every other terminal needs that lock meanwhile.
    drop(entry);
}

#[cfg(test)]
impl LocalSessionHost {
    /// The session's screen as the core sees it.
    fn screen_text(&self, id: SessionId) -> Vec<String> {
        lock(&self.entry(id).expect("running").vt)
            .term
            .screen_text()
    }

    fn running(&self, id: SessionId) -> bool {
        self.entry(id).is_ok()
    }

    fn detached_since(&self, id: SessionId) -> Option<Instant> {
        lock(&self.entry(id).expect("running").view).detached_at
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn n02_the_sessions_lock_is_free_while_an_entry_is_dropped() {
        struct Probe {
            map: Arc<RwLock<HashMap<u32, Probe>>>,
            free: Arc<std::sync::atomic::AtomicBool>,
        }
        impl Drop for Probe {
            fn drop(&mut self) {
                self.free
                    .store(self.map.try_write().is_ok(), Ordering::SeqCst);
            }
        }
        let map = Arc::new(RwLock::new(HashMap::new()));
        let free = Arc::new(std::sync::atomic::AtomicBool::new(false));
        map.write().unwrap().insert(
            1,
            Probe {
                map: Arc::clone(&map),
                free: Arc::clone(&free),
            },
        );
        drop(take_out(&map, &1));
        assert!(free.load(Ordering::SeqCst));
    }

    #[test]
    fn n02_a_hanging_folder_check_gives_up() {
        let started = Instant::now();
        let answer = answer_within(
            || {
                thread::sleep(Duration::from_secs(5));
                true
            },
            Duration::from_millis(50),
        );
        assert_eq!(answer, None);
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(answer_within(|| true, Duration::from_secs(5)), Some(true));
    }

    #[test]
    fn n05_scrollback_is_saved_when_quiet_or_at_the_latest() {
        let start = Instant::now();
        let quiet = snapshot_store::SAVE_WHEN_QUIET;
        let latest = snapshot_store::SAVE_AT_LATEST;
        // Still busy: not yet.
        assert!(!save_due(start, start, start + quiet / 2));
        // Quiet for long enough.
        assert!(save_due(start, start, start + quiet));
        // Output never stops: saved at the latest bound anyway.
        let busy = start
            + latest
                .checked_sub(Duration::from_millis(1))
                .expect("positive");
        assert!(!save_due(start, busy, busy));
        assert!(save_due(start, start + latest, start + latest));
    }

    /// Several stagers of one session (the keeper, the reader at the end, the quit) never leave
    /// an older copy staged over a newer one: each stages under the terminal's lock, so the
    /// newest output is what gets written.
    #[test]
    fn n05_concurrent_stagers_leave_the_newest_snapshot() {
        let dir = std::env::temp_dir().join(format!("wcmd-app-stagers-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Arc::new(SnapshotStore::new(
            &dir,
            true,
            None,
            Box::new(|_: &str| true),
        ));
        let vt = Arc::new(Mutex::new(Vt::new(SIZE)));
        let stagers: Vec<_> = (0..4)
            .map(|t| {
                let (store, vt) = (Arc::clone(&store), Arc::clone(&vt));
                thread::spawn(move || {
                    for n in 0..150 {
                        lock(&vt)
                            .term
                            .advance(format!("stager {t} line {n}\r\n").as_bytes());
                        stage(&store, "b-1", &vt);
                    }
                })
            })
            .collect();
        for stager in stagers {
            stager.join().expect("stager");
        }
        store.write_staged();
        let newest = lock(&vt).term.snapshot(true).expect("main screen");
        let saved = std::fs::read(dir.join(snapshot_store::DIR).join("b-1.snap")).expect("saved");
        assert!(
            wcmd_term::snapshot::decode(&saved).is_some_and(|(_, body)| body == newest),
            "an older snapshot was written"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // Real ConPTY sessions (cmd without shell integration), driven like the UI drives them.

    const TIMEOUT: Duration = Duration::from_secs(60);
    const SIZE: PtySize = PtySize { cols: 60, rows: 12 };

    /// A view as the UI has one: a mirror terminal (xterm.js) fed with the stream.
    struct TestView {
        opened: PtyOpenResult,
        events: Receiver<SessionEvent>,
        seq: u32,
        term: Terminal,
        exited: bool,
        /// Folder reports, in order.
        cwds: Vec<String>,
        agent_exited: bool,
    }

    fn cmd_host() -> LocalSessionHost {
        LocalSessionHost::new(ShellIntegration::disabled())
    }

    /// cmd with WolfCmd's shell integration: its `PROMPT` reports the folder (OSC 9;9) and
    /// marks the prompt (OSC 133;A/B) every time.
    fn integrated_host(name: &str) -> LocalSessionHost {
        let dir = std::env::temp_dir().join(format!("wcmd-n06-{name}-{}", std::process::id()));
        LocalSessionHost::new(ShellIntegration::install(&dir))
    }

    fn open(host: &LocalSessionHost, panel: &str, request: &str) -> TestView {
        open_with(host, panel, request, "cmd")
    }

    fn open_with(host: &LocalSessionHost, panel: &str, request: &str, profile: &str) -> TestView {
        let (tx, rx) = mpsc::channel();
        let opened = host
            .open(
                PtyOpenArgs {
                    request_id: request.to_owned(),
                    size: SIZE,
                    cwd: None,
                    profile_id: Some(profile.to_owned()),
                    panel_id: Some(panel.to_owned()),
                },
                Box::new(move |event| tx.send(event).is_ok()),
            )
            .expect("open");
        TestView {
            opened,
            events: rx,
            seq: 0,
            term: Terminal::new(to_terminal_size(SIZE), 50_000),
            exited: false,
            cwds: Vec::new(),
            agent_exited: false,
        }
    }

    impl TestView {
        fn id(&self) -> SessionId {
            self.opened.session_id
        }

        fn write(&mut self, host: &LocalSessionHost, data: &str) {
            self.send(host, data, None);
        }

        /// Types the agent's start line, as the UI does at the first prompt.
        fn start_agent(&mut self, host: &LocalSessionHost, line: &str) {
            self.send(host, line, Some("test-agent"));
        }

        fn send(&mut self, host: &LocalSessionHost, data: &str, agent: Option<&str>) {
            self.seq += 1;
            host.write(PtyWriteArgs {
                session_id: self.id(),
                attachment: self.opened.attachment,
                seq: self.seq,
                data: data.to_owned(),
                agent: agent.map(str::to_owned),
            })
            .expect("write");
        }

        /// Takes in what arrived (answering ConPTY's cursor query like xterm.js) until `done`.
        fn pump(&mut self, host: &LocalSessionHost, done: impl Fn(&Self) -> bool) {
            let deadline = Instant::now() + TIMEOUT;
            while !done(self) {
                let left = deadline.saturating_duration_since(Instant::now());
                assert!(
                    !left.is_zero(),
                    "timed out; screen: {:?}",
                    self.term.screen_text()
                );
                match self
                    .events
                    .recv_timeout(left.min(Duration::from_millis(100)))
                {
                    Ok(SessionEvent::Output(bytes)) => {
                        self.term.advance(&bytes);
                        if bytes.windows(4).any(|w| w == b"\x1b[6n") {
                            self.write(host, "\x1b[1;1R");
                        }
                    }
                    Ok(SessionEvent::Exited { .. }) => self.exited = true,
                    Ok(SessionEvent::Cwd(dir)) => self.cwds.push(dir),
                    Ok(SessionEvent::AgentExited) => self.agent_exited = true,
                    Err(_) => {}
                }
            }
        }

        fn lines(&self) -> Vec<String> {
            self.term.recent_text(50_000)
        }

        /// Prompt lines on screen and in scrollback (cmd's prompt ends with `>`).
        fn prompts(&self) -> usize {
            self.lines().iter().filter(|l| l.ends_with('>')).count()
        }

        fn shows(&self, line: &str) -> bool {
            self.lines().iter().any(|l| l == line)
        }

        fn prompt(&self) -> bool {
            self.lines().last().is_some_and(|l| l.ends_with('>'))
        }
    }

    fn core_lines(host: &LocalSessionHost, id: SessionId) -> Vec<String> {
        lock(&host.entry(id).expect("running").vt)
            .term
            .recent_text(50_000)
    }

    fn until(condition: impl Fn() -> bool) {
        let deadline = Instant::now() + TIMEOUT;
        while !condition() {
            assert!(Instant::now() < deadline, "timed out");
            thread::sleep(Duration::from_millis(20));
        }
    }

    /// A reloaded page attaches to the running shell: the replay shows exactly what the core
    /// has, and typing goes on in the same shell; nothing is shown twice.
    #[test]
    fn n02_reattach_replays_the_screen_and_continues() {
        let host = cmd_host();
        let mut first = open(&host, "p1", "r1");
        assert!(!first.opened.attached);
        first.pump(&host, TestView::prompt);
        first.write(&host, "echo hello-1\r");
        first.pump(&host, |v| v.shows("hello-1") && v.prompt());

        host.detach_all();
        assert!(host.running(first.id()));
        let mut second = open(&host, "p1", "r2");
        assert!(second.opened.attached);
        assert_eq!(second.id(), first.id());
        second.pump(&host, |v| v.lines() == core_lines(&host, v.id()));
        assert_eq!(second.term.screen_text(), host.screen_text(second.id()));

        second.write(&host, "echo hello-2\r");
        second.pump(&host, |v| v.shows("hello-2") && v.prompt());
        second.pump(&host, |v| v.lines() == core_lines(&host, v.id()));
        let count =
            |view: &TestView, line: &str| view.lines().iter().filter(|l| *l == line).count();
        assert_eq!(count(&second, "hello-1"), 1);
        assert_eq!(count(&second, "hello-2"), 1);
        // The detached view got nothing after it was detached, and its input is ignored.
        let late: Vec<_> = first.events.try_iter().collect();
        assert_eq!(late, []);
        first.write(&host, "echo stale\r");
        host.kill_all();
        second.pump(&host, |v| v.exited);
        assert!(!second.shows("stale"));
    }

    /// Two opens of one panel (React `StrictMode` mounts twice) share one shell; a late detach
    /// from the first view changes nothing.
    #[test]
    fn n02_a_second_open_of_a_panel_attaches_instead_of_spawning() {
        let host = cmd_host();
        let first = open(&host, "p1", "r1");
        let mut second = open(&host, "p1", "r2");
        assert_eq!(second.id(), first.id());
        assert!(second.opened.attached);
        host.detach(PtyDetachArgs {
            session_id: first.id(),
            attachment: first.opened.attachment,
        });
        assert_eq!(host.detached_since(second.id()), None);
        // A repeated request returns the same answer without attaching again.
        let again = open(&host, "p1", "r2");
        assert_eq!(again.opened.attachment, second.opened.attachment);
        second.pump(&host, TestView::prompt);
        assert_eq!(host.entries().len(), 1);
        host.kill_all();
    }

    /// The output of a flooding command while views come and go: the last view shows every
    /// line once, in order, exactly as the core does.
    #[test]
    fn n02_attaching_during_a_flood_loses_and_repeats_nothing() {
        let host = cmd_host();
        let mut view = open(&host, "p1", "r0");
        view.pump(&host, TestView::prompt);
        view.write(&host, "for /L %i in (1,1,3000) do @echo n%i\r");
        for round in 1..=12 {
            thread::sleep(Duration::from_millis(15));
            if round % 2 == 0 {
                host.detach_all();
            }
            view = open(&host, "p1", &format!("r{round}"));
        }
        view.pump(&host, |v| v.shows("n3000") && v.prompt());
        view.pump(&host, |v| v.lines() == core_lines(&host, v.id()));
        let numbers: Vec<u32> = view
            .lines()
            .iter()
            .filter_map(|l| l.strip_prefix('n')?.parse().ok())
            .collect();
        assert_eq!(numbers.last(), Some(&3000));
        for pair in numbers.windows(2) {
            assert_eq!(pair[1], pair[0] + 1, "{numbers:?}");
        }
        host.kill_all();
    }

    /// While detached the shell never waits for a view: far more than the flow-control limit
    /// goes through with no acks.
    #[test]
    fn n02_a_detached_session_never_pauses() {
        let host = cmd_host();
        let mut view = open(&host, "p1", "r1");
        view.pump(&host, TestView::prompt);
        let line = "x".repeat(1000);
        let count = super::super::flow::HIGH_WATERMARK / line.len() * 2;
        view.write(
            &host,
            &format!("for /L %i in (1,1,{count}) do @echo {line}\r"),
        );
        // The view never acks: attached, the shell would stop at the high watermark.
        host.detach_all();
        let entry = host.entry(view.id()).expect("running");
        until(|| {
            let vt = lock(&entry.vt);
            vt.advanced > super::super::flow::HIGH_WATERMARK as u64 * 3 / 2
                && vt
                    .term
                    .recent_text(1)
                    .last()
                    .is_some_and(|l| l.ends_with('>'))
        });
        assert!(!entry.flow.is_paused());
        host.kill_all();
    }

    /// N-01: hidden to the tray, an attached session never waits for its view: far more than the
    /// flow-control limit goes through with no acks, while what is sent to the view stays
    /// bounded. Shown again, the view catches up from the screen state and then shows every
    /// later byte once.
    #[test]
    fn n01_hidden_to_the_tray_a_session_never_pauses_and_catches_up_when_shown() {
        use super::super::flow::HIGH_WATERMARK;
        let host = cmd_host();
        let mut view = open(&host, "p1", "r1");
        view.pump(&host, TestView::prompt);
        host.set_background(true);
        let line = "x".repeat(1000);
        let count = HIGH_WATERMARK / line.len() * 2;
        view.write(
            &host,
            &format!("for /L %i in (1,1,{count}) do @echo {line}\r"),
        );
        view.write(&host, "echo flood-done\r");
        // The view never acks (a throttled page): shown, the shell would stop at the limit.
        let entry = host.entry(view.id()).expect("running");
        until(|| {
            let vt = lock(&entry.vt);
            vt.advanced > HIGH_WATERMARK as u64 * 3 / 2
                && vt.term.recent_text(3).iter().any(|l| l == "flood-done")
                && vt
                    .term
                    .recent_text(1)
                    .last()
                    .is_some_and(|l| l.ends_with('>'))
        });
        assert!(!entry.flow.is_paused());
        // What waits for the page is bounded: the limit and one batch at most.
        assert!(
            entry.flow.unacked() <= HIGH_WATERMARK + 1024 * 1024,
            "{}",
            entry.flow.unacked()
        );
        assert!(
            lock(&entry.view)
                .attachment
                .as_ref()
                .is_some_and(|a| a.behind)
        );

        // Shown: the view resets and replays the core's screen.
        host.set_background(false);
        view.pump(&host, |v| v.term.screen_text() == host.screen_text(v.id()));
        assert!(view.shows("flood-done"));
        // From there every byte arrives once.
        view.write(&host, "echo after-the-tray\r");
        view.pump(&host, |v| v.shows("after-the-tray") && v.prompt());
        let shown = view.lines();
        assert_eq!(shown.iter().filter(|l| *l == "after-the-tray").count(), 1);
        assert_eq!(view.term.screen_text(), host.screen_text(view.id()));
        assert!(!entry.flow.is_paused());
        host.kill_all();
    }

    /// Closing a panel ends its session; a detached one whose panel is gone ends after
    /// `ORPHAN_AFTER`; one whose panel is still there lives on.
    #[test]
    fn n02_closed_and_orphaned_panels_end_their_sessions() {
        let present = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let check = Arc::clone(&present);
        let host = cmd_host().with_panels(Box::new(move |_: &str| check.load(Ordering::SeqCst)));

        let mut closed = open(&host, "closed", "r1");
        closed.pump(&host, TestView::prompt);
        host.kill_panels(&HashSet::from(["closed".to_owned()]));
        closed.pump(&host, |v| v.exited);

        let away = open(&host, "away", "r2");
        host.detach_all();
        let detached = host.detached_since(away.id()).expect("detached");
        // Not long enough, or the panel is still in the document: it lives.
        host.sweep(detached + ORPHAN_AFTER / 2);
        host.sweep(detached + ORPHAN_AFTER);
        assert!(host.running(away.id()));
        present.store(false, Ordering::SeqCst);
        host.sweep(detached + ORPHAN_AFTER);
        until(|| !host.running(away.id()));
    }

    /// N-11: a closed panel an undo can bring back keeps its session through the undo grace (no
    /// orphan sweep ends it); an undo within it reattaches the same shell with its screen; closed
    /// again, it ends once the grace is over, its scrollback saved for a later undo.
    #[test]
    fn n11_a_closed_panel_survives_the_undo_grace_and_ends_after_it() {
        use super::super::undo_grace::UNDO_GRACE;

        let present = Arc::new(Mutex::new(HashSet::from(["p".to_owned()])));
        let check = Arc::clone(&present);
        let dir = std::env::temp_dir().join(format!("wcmd-n11-grace-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let grace = Arc::new(UndoGrace::default());
        let kept = Arc::clone(&grace);
        let doc = Arc::clone(&present);
        let store = SnapshotStore::new(
            &dir,
            true,
            None,
            Box::new(move |panel: &str| lock(&doc).contains(panel) || kept.holds(panel)),
        );
        let host = cmd_host()
            .with_snapshots(store)
            .with_undo_grace(grace)
            .with_panels(Box::new(move |panel: &str| lock(&check).contains(panel)));
        let undoable = HashSet::from(["p".to_owned()]);
        let close = |at: Instant| {
            lock(&present).remove("p");
            host.close_panels(&HashSet::from(["p".to_owned()]), |_| false, &undoable, at);
        };

        let mut view = open(&host, "p", "r1");
        view.pump(&host, TestView::prompt);
        view.write(&host, "echo before-close\r");
        view.pump(&host, |v| v.shows("before-close") && v.prompt());
        let closed_at = Instant::now();
        close(closed_at);
        host.detach_all();
        // Detached longer than an orphan may be, and still waiting for the undo.
        host.sweep(closed_at + ORPHAN_AFTER);
        assert!(host.running(view.id()));

        // Undo within the grace: the panel is back, the same shell reattaches with its screen.
        lock(&present).insert("p".to_owned());
        host.close_panels(
            &HashSet::new(),
            |panel| panel == "p",
            &HashSet::new(),
            closed_at,
        );
        let mut back = open(&host, "p", "r2");
        assert!(back.opened.attached);
        assert_eq!(back.id(), view.id());
        back.pump(&host, |v| v.shows("before-close"));

        // Closed again: it ends once the grace is over, not before.
        let again = Instant::now();
        close(again);
        host.detach_all();
        host.sweep(again + UNDO_GRACE / 2);
        assert!(host.running(back.id()));
        host.sweep(again + UNDO_GRACE);
        until(|| !host.running(back.id()));
        // What it showed is kept: an undo after the grace shows it above a new shell.
        lock(&present).insert("p".to_owned());
        let mut reopened = open(&host, "p", "r3");
        assert!(!reopened.opened.attached);
        // (The test view answers the cursor query with the top left, so the new prompt lands
        // there; xterm.js answers where the cursor really is, below the restored lines.)
        reopened.pump(&host, |v| {
            v.shows("before-close") && v.lines().iter().any(|l| l.starts_with("── restored from"))
        });
        host.kill_all();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// N-10: ending a worktree's panels waits until their shells are gone, so the folder they
    /// stood in can be deleted; other panels keep running.
    #[test]
    fn n10_ended_panels_release_their_folder() {
        let dir = std::env::temp_dir().join(format!("wcmd n10 end {}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        let host = cmd_host();
        let open_in = |panel: &str| {
            let (tx, rx) = mpsc::channel();
            let opened = host
                .open(
                    PtyOpenArgs {
                        request_id: panel.to_owned(),
                        size: SIZE,
                        cwd: Some(dir.join("sub").display().to_string()),
                        profile_id: Some("cmd".to_owned()),
                        panel_id: Some(panel.to_owned()),
                    },
                    Box::new(move |event| tx.send(event).is_ok()),
                )
                .expect("open");
            (opened, rx)
        };
        let (worktree, _events) = open_in("in-worktree");
        let mut other = open(&host, "other", "r-other");
        other.pump(&host, TestView::prompt);

        assert!(host.end_panels(
            &HashSet::from(["in-worktree".to_owned()]),
            Duration::from_secs(10)
        ));
        assert!(!host.running(worktree.session_id));
        std::fs::remove_dir_all(&dir).expect("the folder is free");
        assert!(host.running(other.id()));
        // Nothing to end: at once.
        assert!(host.end_panels(&HashSet::from(["gone".to_owned()]), Duration::ZERO));
        host.kill_all();
    }

    /// N-06: the agent's command ending (the shell's next prompt mark) is reported on the
    /// stream, and to a view that attaches later; while it runs, nothing is reported.
    #[test]
    fn n06_an_agent_that_ended_is_reported_live_and_on_reattach() {
        let host = integrated_host("agent");
        let mut first = open(&host, "p1", "r1");
        assert!(first.opened.integrated);
        assert!(!first.opened.agent_exited);
        first.pump(&host, TestView::prompt);
        // An "agent" that waits for input: still running when a view attaches.
        first.start_agent(&host, "set /p answer=agent? \r");
        first.pump(&host, |v| v.shows("agent?"));
        host.detach_all();
        let mut second = open(&host, "p1", "r2");
        assert!(second.opened.attached);
        assert!(second.opened.integrated);
        assert!(!second.opened.agent_exited);
        // The agent ends: the shell shows its next prompt.
        second.write(&host, "bye\r");
        second.pump(&host, |v| v.agent_exited);
        assert!(!first.agent_exited);
        // A view that attaches afterwards learns it from the open.
        host.detach_all();
        let third = open(&host, "p1", "r3");
        assert!(third.opened.agent_exited);
        // Without shell integration nothing marks prompts: never reported.
        let plain = cmd_host();
        let view = open(&plain, "p2", "r4");
        assert!(!view.opened.integrated);
        host.kill_all();
        plain.kill_all();
    }

    /// N-03: cmd reports its folder at every prompt; the view hears of it once, and again only
    /// when it changes.
    #[test]
    fn n03_the_same_folder_is_reported_once() {
        let host = integrated_host("cwd");
        let mut view = open(&host, "p1", "r1");
        view.pump(&host, |v| v.prompt() && !v.cwds.is_empty());
        for _ in 0..3 {
            view.write(&host, "\r");
        }
        view.pump(&host, |v| v.prompts() >= 4);
        assert_eq!(view.cwds.len(), 1, "{:?}", view.cwds);
        view.write(&host, "cd ..\r");
        view.pump(&host, |v| v.cwds.len() == 2);
        assert_ne!(view.cwds[0], view.cwds[1]);
        host.kill_all();
    }

    /// N-06: a panel whose saved profile is gone runs the default shell, and says which.
    #[test]
    fn n06_a_gone_profile_reports_the_shell_it_really_runs() {
        let host = cmd_host();
        let view = open_with(&host, "p1", "r1", "no-such-shell");
        assert_eq!(view.opened.profile_id, host.default_profile().id);
        let cmd = open(&host, "p2", "r2");
        assert_eq!(cmd.opened.profile_id, "cmd");
        host.kill_all();
    }

    /// N-07: the default shell setting picks the shell of a terminal without a profile (a gone
    /// one too) and is the one the profile list marks; `WOLFCMD_DEFAULT_PROFILE` still wins.
    #[test]
    fn n07_the_default_shell_setting_runs_and_is_marked() {
        let host = cmd_host().with_default_profile(Box::new(|| Some("cmd".to_owned())));
        let expected = std::env::var(wcmd_pty::DEFAULT_PROFILE_ENV)
            .ok()
            .and_then(|id| find_profile(&id))
            .map_or_else(|| "cmd".to_owned(), |p| p.id);
        assert_eq!(host.default_profile().id, expected);
        let view = open_with(&host, "p1", "r1", "no-such-shell");
        assert_eq!(view.opened.profile_id, expected);
        let marked: Vec<_> = host
            .profiles()
            .into_iter()
            .filter(|p| p.is_default)
            .collect();
        assert_eq!(marked.len(), 1);
        assert_eq!(marked[0].id, expected);
        host.kill_all();
    }

    /// N-06: an agent's working title reaches the activity sink (working, then idle) with no
    /// view needed, a view that attaches meanwhile hears it works, and its end makes it idle.
    #[test]
    fn n06_an_agents_title_reports_working_and_idle() {
        let (tx, changes) = mpsc::channel();
        let host = integrated_host("activity").with_title_patterns(Box::new(|agent: &str| {
            (agent == "test-agent").then(|| TitlePattern::new("busy now").expect("pattern"))
        }));
        host.on_activity(Box::new(move |panel: &str, working: bool| {
            let _ = tx.send((panel.to_owned(), working));
        }));
        let next = || changes.recv_timeout(TIMEOUT).expect("an activity change");
        let mut view = open(&host, "p1", "r1");
        view.pump(&host, TestView::prompt);
        // The stand-in agent: a nested Command Prompt reading lines; `title` is its spinner.
        view.start_agent(&host, "cmd /d /q /k prompt $G\r");
        view.write(&host, "title busy now\r");
        assert_eq!(next(), ("p1".to_owned(), true));
        // Detached, it keeps being watched; a view that attaches learns it works.
        host.detach_all();
        let mut second = open(&host, "p1", "r2");
        assert!(second.opened.agent_working);
        second.write(&host, "title idle now\r");
        assert_eq!(next(), ("p1".to_owned(), false));
        second.write(&host, "title busy now\r");
        assert_eq!(next(), ("p1".to_owned(), true));
        // The agent ends while working: idle.
        second.write(&host, "exit\r");
        assert_eq!(next(), ("p1".to_owned(), false));
        second.pump(&host, |v| v.agent_exited);
        assert!(changes.try_recv().is_err());
        host.kill_all();
    }
}
