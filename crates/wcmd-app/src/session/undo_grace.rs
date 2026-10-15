//! N-11: closed panels an undo can still bring back. Closing a panel no longer ends its session
//! at once: while the UI's undo history holds the panel (`state_save`'s `undoable`), its shell
//! (or agent) keeps running for [`UNDO_GRACE`], so an undo reattaches the same session, screen
//! and all. It ends at the first of: the grace running out (the keeper's sweep), the history
//! dropping the panel (a later save without it in `undoable`; a reloaded page sends none), the
//! panel's worktree being removed, or quit. A panel brought back into the document is simply a
//! panel again.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

/// How long a closed panel's session waits for an undo.
pub(crate) const UNDO_GRACE: Duration = Duration::from_secs(60);

/// The closed panels whose sessions wait for an undo, each with when its grace ends.
#[derive(Debug, Default)]
pub(crate) struct UndoGrace {
    kept: Mutex<HashMap<String, Instant>>,
}

impl UndoGrace {
    fn kept(&self) -> MutexGuard<'_, HashMap<String, Instant>> {
        self.kept.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// After a save: `closed` just left the document, `present` tells whether a panel is in it
    /// now, and `undoable` are the panels the UI's history can still bring back. A closed panel
    /// that can come back waits ([`UNDO_GRACE`] from `now`); a waiting one that came back is a
    /// panel again; the rest (closed for good, or dropped from the history) end now: returned.
    pub(crate) fn settle(
        &self,
        closed: &HashSet<String>,
        present: impl Fn(&str) -> bool,
        undoable: &HashSet<String>,
        now: Instant,
    ) -> HashSet<String> {
        let mut kept = self.kept();
        let mut ending = HashSet::new();
        kept.retain(|panel, _| {
            if present(panel) {
                return false;
            }
            let waits = undoable.contains(panel);
            if !waits {
                ending.insert(panel.clone());
            }
            waits
        });
        for panel in closed {
            if undoable.contains(panel) {
                kept.entry(panel.clone()).or_insert(now + UNDO_GRACE);
            } else {
                ending.insert(panel.clone());
            }
        }
        ending
    }

    /// Whether `panel`'s session waits for an undo (it counts as a panel: never an orphan, its
    /// scrollback saved).
    pub(crate) fn holds(&self, panel: &str) -> bool {
        self.kept().contains_key(panel)
    }

    /// The waiting panels whose grace is over at `now` (still waiting: see [`Self::release`]).
    pub(crate) fn expired(&self, now: Instant) -> Vec<String> {
        self.kept()
            .iter()
            .filter(|&(_, until)| now >= *until)
            .map(|(panel, _)| panel.clone())
            .collect()
    }

    /// Stops waiting for those of `panels` still waiting with their grace over at `now` (a save
    /// may have brought one back meanwhile); returns them.
    pub(crate) fn release(&self, panels: &[String], now: Instant) -> HashSet<String> {
        let mut kept = self.kept();
        let mut released = HashSet::new();
        for panel in panels {
            if kept.get(panel).is_some_and(|until| now >= *until) {
                kept.remove(panel);
                released.insert(panel.clone());
            }
        }
        released
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|&id| id.to_owned()).collect()
    }

    /// N-11: a closed panel the history holds waits; one it doesn't hold ends at once.
    #[test]
    fn n11_a_closed_panel_waits_only_while_it_can_be_undone() {
        let grace = UndoGrace::default();
        let now = Instant::now();
        let ending = grace.settle(&set(&["a", "b"]), |_| false, &set(&["a"]), now);
        assert_eq!(ending, set(&["b"]));
        assert!(grace.holds("a") && !grace.holds("b"));
    }

    /// N-11: the grace runs out after `UNDO_GRACE`, not before.
    #[test]
    fn n11_the_grace_runs_out() {
        let grace = UndoGrace::default();
        let now = Instant::now();
        grace.settle(&set(&["a"]), |_| false, &set(&["a"]), now);
        assert_eq!(grace.expired(now + UNDO_GRACE / 2), Vec::<String>::new());
        let over = grace.expired(now + UNDO_GRACE);
        assert_eq!(over, ["a"]);
        assert_eq!(grace.release(&over, now + UNDO_GRACE), set(&["a"]));
        assert!(!grace.holds("a"));
    }

    /// N-11: an undo brings the panel back: it is a panel again, and nothing ends it.
    #[test]
    fn n11_a_panel_brought_back_stops_waiting() {
        let grace = UndoGrace::default();
        let now = Instant::now();
        grace.settle(&set(&["a"]), |_| false, &set(&["a"]), now);
        let ending = grace.settle(&set(&[]), |panel| panel == "a", &set(&[]), now);
        assert!(ending.is_empty());
        assert!(!grace.holds("a"));
        // A release decided before the undo landed finds nothing to end.
        assert!(
            grace
                .release(&["a".to_owned()], now + UNDO_GRACE)
                .is_empty()
        );
    }

    /// N-11: once the history drops a waiting panel (a new step cleared the redo, the depth
    /// was reached, a reloaded page has none), its session ends at the next save.
    #[test]
    fn n11_a_panel_the_history_dropped_ends() {
        let grace = UndoGrace::default();
        let now = Instant::now();
        grace.settle(&set(&["a", "b"]), |_| false, &set(&["a", "b"]), now);
        let ending = grace.settle(&set(&[]), |_| false, &set(&["b"]), now);
        assert_eq!(ending, set(&["a"]));
        assert!(grace.holds("b"));
    }

    /// N-11: closed again after an undo, a panel gets a fresh grace.
    #[test]
    fn n11_closing_again_starts_a_fresh_grace() {
        let grace = UndoGrace::default();
        let start = Instant::now();
        grace.settle(&set(&["a"]), |_| false, &set(&["a"]), start);
        grace.settle(&set(&[]), |panel| panel == "a", &set(&[]), start);
        let later = start + UNDO_GRACE / 2;
        grace.settle(&set(&["a"]), |_| false, &set(&["a"]), later);
        assert_eq!(grace.expired(start + UNDO_GRACE), Vec::<String>::new());
        assert_eq!(grace.expired(later + UNDO_GRACE), ["a"]);
    }
}
