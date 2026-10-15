//! N-02: the page watchdog. A hung page (a stuck script, a renderer that stopped painting)
//! must not cost the user their terminals: every [`PING_EVERY`] the core asks the page for a
//! sign of life (`window.__wcPing()`, answered by `app_pong`); when none came for
//! [`HANG_AFTER`] while the window is on screen, the page is logged and reloaded. The sessions
//! live in the core, so the reloaded page attaches to them again (`LocalSessionHost::open`).
//!
//! Cheap: one tiny script per [`PING_EVERY`] while the window is shown, nothing while it is
//! minimized or hidden (N-01: also hidden to the tray; a hidden page may be throttled, so silence
//! then means nothing).
//! `WOLFCMD_WATCHDOG=0` turns it off (e.g. while debugging the page with breakpoints).

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use tauri::WebviewWindow;

use crate::platform;

/// How often the page is asked.
pub(crate) const PING_EVERY: Duration = Duration::from_secs(2);
/// Silence for this long, from a page that has answered before, means it hangs.
pub(crate) const HANG_AFTER: Duration = Duration::from_secs(10);
/// A page that is still loading gets this long for its first answer (doubled after each reload
/// that never answered, up to 16 times), so a slow start is not a hang.
pub(crate) const LOAD_GRACE: Duration = Duration::from_secs(30);

/// What the watchdog does next.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Step {
    /// Nothing (the window is not on screen).
    Wait,
    /// Ask the page.
    Ping,
    /// The page hangs: reload it.
    Reload,
}

/// The watchdog's clock-driven state (pure: the time comes in, so tests use a fake clock).
#[derive(Debug)]
pub(crate) struct Watch {
    /// The last answer, page load, or time off screen.
    last_sign: Instant,
    /// The page has answered since it (re)loaded.
    answered: bool,
    /// Reloads in a row after which the page never answered.
    silent_reloads: u32,
}

impl Watch {
    pub(crate) fn new(now: Instant) -> Self {
        Self {
            last_sign: now,
            answered: false,
            silent_reloads: 0,
        }
    }

    /// One tick of the watchdog at `now`; `shown`: the window is visible and not minimized.
    pub(crate) fn tick(&mut self, now: Instant, shown: bool) -> Step {
        if !shown {
            self.last_sign = now;
            return Step::Wait;
        }
        let limit = if self.answered {
            HANG_AFTER
        } else {
            LOAD_GRACE * (1 << self.silent_reloads.min(4))
        };
        if now.saturating_duration_since(self.last_sign) < limit {
            return Step::Ping;
        }
        if !self.answered {
            self.silent_reloads += 1;
        }
        self.page_loading(now);
        Step::Reload
    }

    /// The page answered.
    pub(crate) fn answered(&mut self, now: Instant) {
        self.last_sign = now;
        self.answered = true;
        self.silent_reloads = 0;
    }

    /// The page (re)loads: it gets [`LOAD_GRACE`] to answer.
    pub(crate) fn page_loading(&mut self, now: Instant) {
        self.last_sign = now;
        self.answered = false;
    }
}

/// The app's watchdog, shared by its thread, `app_pong` and the page-load handler.
#[derive(Debug)]
pub(crate) struct Watchdog(Mutex<Watch>);

impl Default for Watchdog {
    fn default() -> Self {
        Self(Mutex::new(Watch::new(Instant::now())))
    }
}

impl Watchdog {
    fn watch(&self) -> MutexGuard<'_, Watch> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn answered(&self) {
        self.watch().answered(Instant::now());
    }

    pub(crate) fn page_loading(&self) {
        self.watch().page_loading(Instant::now());
    }

    /// Starts the `page-watchdog` thread for `window` (unless `WOLFCMD_WATCHDOG=0`).
    pub(crate) fn start(self: &Arc<Self>, window: WebviewWindow) {
        if std::env::var_os("WOLFCMD_WATCHDOG").is_some_and(|v| v == "0") {
            tracing::info!("N-02: page watchdog off (WOLFCMD_WATCHDOG=0)");
            return;
        }
        let handle = match platform::window_handle(&window) {
            Ok(handle) => handle,
            Err(error) => {
                tracing::warn!(%error, "N-02: no page watchdog");
                return;
            }
        };
        let watchdog = Arc::clone(self);
        let started = std::thread::Builder::new()
            .name("page-watchdog".to_owned())
            .spawn(move || {
                loop {
                    std::thread::sleep(PING_EVERY);
                    // N-01: hidden to the tray, nothing is asked (macOS and Linux can't read the
                    // window's visibility off the UI thread, so the tray says it).
                    let shown = platform::is_shown(handle) && !crate::tray::hidden();
                    let step = watchdog.watch().tick(Instant::now(), shown);
                    let result = match step {
                        Step::Wait => Ok(()),
                        Step::Ping => window.eval("window.__wcPing?.()"),
                        Step::Reload => {
                            tracing::warn!(
                                "N-02: the page stopped answering; reloading it (terminals keep running)"
                            );
                            window.reload()
                        }
                    };
                    if let Err(error) = result {
                        tracing::debug!(%error, "page watchdog step failed");
                    }
                }
            });
        if let Err(error) = started {
            tracing::warn!(%error, "N-02: no page watchdog");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHOWN: bool = true;

    #[test]
    fn n02_watchdog_reloads_a_page_that_stopped_answering() {
        let start = Instant::now();
        let mut watch = Watch::new(start);
        watch.answered(start);
        assert_eq!(watch.tick(start + PING_EVERY, SHOWN), Step::Ping);
        // Answers keep it alive.
        watch.answered(start + HANG_AFTER);
        assert_eq!(
            watch.tick(start + HANG_AFTER + PING_EVERY, SHOWN),
            Step::Ping
        );
        // Then silence for HANG_AFTER: reload, once.
        let hung = start + HANG_AFTER * 2;
        assert_eq!(watch.tick(hung, SHOWN), Step::Reload);
        assert_eq!(watch.tick(hung + PING_EVERY, SHOWN), Step::Ping);
    }

    #[test]
    fn n02_watchdog_expects_nothing_while_minimized() {
        let start = Instant::now();
        let mut watch = Watch::new(start);
        watch.answered(start);
        // Minimized for a minute: no pings, no reload.
        let back = start + Duration::from_secs(60);
        assert_eq!(watch.tick(back, false), Step::Wait);
        // Shown again: the page gets the full time to answer.
        assert_eq!(watch.tick(back + HANG_AFTER / 2, SHOWN), Step::Ping);
        assert_eq!(watch.tick(back + HANG_AFTER, SHOWN), Step::Reload);
    }

    #[test]
    fn n02_watchdog_gives_a_loading_page_time_and_backs_off() {
        let start = Instant::now();
        let mut watch = Watch::new(start);
        // Never answered since loading: HANG_AFTER is not enough to call it hung.
        assert_eq!(watch.tick(start + HANG_AFTER, SHOWN), Step::Ping);
        let first = start + LOAD_GRACE;
        assert_eq!(watch.tick(first, SHOWN), Step::Reload);
        // Still silent after the reload: the next one waits twice as long.
        assert_eq!(watch.tick(first + LOAD_GRACE, SHOWN), Step::Ping);
        let second = first + LOAD_GRACE * 2;
        assert_eq!(watch.tick(second, SHOWN), Step::Reload);
        // An answer resets the back-off.
        watch.answered(second);
        assert_eq!(watch.tick(second + HANG_AFTER, SHOWN), Step::Reload);
    }
}
