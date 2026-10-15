//! N-06: whether a panel's agent is working or waiting for the user, from what the terminal
//! already sees: no hooks, nothing written into the agent's settings
//! (`docs/design/N-06-agent-activity.md`). Pure: the session reader feeds it output and titles,
//! the input path its clock ([`InputMarks`]), the keeper's existing tick ends a quiet spell.
//!
//! - **The title**, for an agent with a `working_title` pattern: once the title matched it, the
//!   title alone decides (matching: working; anything else: idle).
//! - **Output activity** otherwise: output more than [`ECHO`] after the last input (not the echo
//!   of keystrokes or a redraw after a resize) lasting [`SUSTAIN`] (pauses under [`GAP`]) is
//!   working; [`QUIET`] without it is idle. Only after the user submitted something (Enter)
//!   since the agent started: its start-up screen and a resumed session's history never count.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use wcmd_agents::TitlePattern;

/// Output this soon after input is its echo (or the redraw it caused).
pub(crate) const ECHO: Duration = Duration::from_millis(300);
/// Output lasting this long (no pause over [`GAP`]) means the agent works.
pub(crate) const SUSTAIN: Duration = Duration::from_secs(1);
/// A pause longer than this starts a new burst of output.
pub(crate) const GAP: Duration = Duration::from_secs(1);
/// No output for this long: the agent waits again. Seen at the keeper's next tick (1 s), so
/// idle shows 2–3 s after the last output.
pub(crate) const QUIET: Duration = Duration::from_secs(2);

/// N-06: what the session's input path saw, lock-free (keystrokes never wait for the reader).
#[derive(Debug)]
pub(crate) struct InputMarks {
    epoch: Instant,
    /// Milliseconds after `epoch` of the last input, plus one; 0: none yet.
    last: AtomicU64,
    /// How many writes held Enter (a submitted prompt, a confirmed choice).
    submits: AtomicU64,
}

/// A copy of [`InputMarks`] at one moment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct InputSeen {
    pub(crate) last: Option<Instant>,
    pub(crate) submits: u64,
}

impl InputMarks {
    pub(crate) fn new(epoch: Instant) -> Self {
        Self {
            epoch,
            last: AtomicU64::new(0),
            submits: AtomicU64::new(0),
        }
    }

    /// Input reached the shell at `now`. `data` is what was written (`None`: a resize).
    pub(crate) fn input(&self, now: Instant, data: Option<&[u8]>) {
        let ms = u64::try_from(now.saturating_duration_since(self.epoch).as_millis())
            .unwrap_or(u64::MAX - 1);
        self.last.store(ms + 1, Ordering::Relaxed);
        if data.is_some_and(holds_enter) {
            self.submits.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub(crate) fn seen(&self) -> InputSeen {
        let last = match self.last.load(Ordering::Relaxed) {
            0 => None,
            ms => Some(self.epoch + Duration::from_millis(ms - 1)),
        };
        InputSeen {
            last,
            submits: self.submits.load(Ordering::Relaxed),
        }
    }
}

/// Enter as xterm sends it: `\r`, or the Kitty keyboard protocol's `CSI 13 … u`.
fn holds_enter(data: &[u8]) -> bool {
    data.contains(&b'\r') || data.windows(4).any(|w| w == b"\x1b[13")
}

/// N-06: one running agent's state.
#[derive(Debug)]
pub(crate) struct ActivityWatch {
    pattern: Option<TitlePattern>,
    /// The title matched `pattern` once: from then on it alone decides.
    by_title: bool,
    working: bool,
    /// Submits counted when the agent started; activity counts only after the next one.
    submits_at_start: u64,
    /// The current burst of output: its first and last chunk.
    burst: Option<(Instant, Instant)>,
}

impl ActivityWatch {
    /// The agent's line was just typed (`input`: the marks before it).
    pub(crate) fn new(pattern: Option<TitlePattern>, input: InputSeen) -> Self {
        Self {
            pattern,
            by_title: false,
            working: false,
            submits_at_start: input.submits,
            burst: None,
        }
    }

    pub(crate) fn working(&self) -> bool {
        self.working
    }

    /// A chunk of output at `now`. `Some(state)` when the state changed.
    pub(crate) fn output(&mut self, now: Instant, input: InputSeen) -> Option<bool> {
        if self.by_title || input.submits <= self.submits_at_start {
            return None;
        }
        // While it works, any output keeps it working (the user may type meanwhile).
        if self.working {
            if let Some((start, _)) = self.burst {
                self.burst = Some((start, now));
            }
            return None;
        }
        if input
            .last
            .is_some_and(|at| now.saturating_duration_since(at) < ECHO)
        {
            return None;
        }
        let start = match self.burst {
            Some((start, last)) if now.saturating_duration_since(last) <= GAP => start,
            _ => now,
        };
        self.burst = Some((start, now));
        if now.saturating_duration_since(start) >= SUSTAIN {
            self.working = true;
            return Some(true);
        }
        None
    }

    /// The terminal title changed to `title`. `Some(state)` when the state changed.
    pub(crate) fn title(&mut self, title: &str) -> Option<bool> {
        let working = self.pattern.as_ref()?.working(title);
        self.by_title |= working;
        if !self.by_title {
            return None;
        }
        self.burst = None;
        self.set(working)
    }

    /// The keeper's tick: a quiet working agent waits again.
    pub(crate) fn tick(&mut self, now: Instant) -> Option<bool> {
        if self.by_title || !self.working {
            return None;
        }
        let quiet = self
            .burst
            .is_none_or(|(_, last)| now.saturating_duration_since(last) >= QUIET);
        if !quiet {
            return None;
        }
        self.burst = None;
        self.set(false)
    }

    /// The agent ended: idle, if it wasn't.
    pub(crate) fn ended(&mut self) -> Option<bool> {
        self.set(false)
    }

    fn set(&mut self, working: bool) -> Option<bool> {
        (self.working != working).then(|| {
            self.working = working;
            working
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: Duration = Duration::from_millis(1);

    /// A watch and its input on a fake clock.
    struct Rig {
        t0: Instant,
        marks: InputMarks,
        watch: ActivityWatch,
        /// Every change, as (ms after t0, working).
        changes: Vec<(u64, bool)>,
    }

    impl Rig {
        fn new(pattern: Option<&str>) -> Self {
            let t0 = Instant::now();
            let marks = InputMarks::new(t0);
            // The agent's line: the UI types it, the watch starts after it.
            let watch =
                ActivityWatch::new(pattern.map(|p| TitlePattern::new(p).unwrap()), marks.seen());
            Self {
                t0,
                marks,
                watch,
                changes: Vec::new(),
            }
        }

        fn at(&self, ms: u64) -> Instant {
            self.t0 + MS * u32::try_from(ms).unwrap()
        }

        fn record(&mut self, ms: u64, change: Option<bool>) {
            if let Some(working) = change {
                self.changes.push((ms, working));
            }
        }

        fn key(&mut self, ms: u64, data: &str) {
            self.marks.input(self.at(ms), Some(data.as_bytes()));
        }

        fn out(&mut self, ms: u64) {
            let change = self.watch.output(self.at(ms), self.marks.seen());
            self.record(ms, change);
        }

        /// Output every `step` ms from `from` to `to`.
        fn stream(&mut self, from: u64, to: u64, step: u64) {
            let mut ms = from;
            while ms <= to {
                self.out(ms);
                ms += step;
            }
        }

        fn title(&mut self, ms: u64, title: &str) {
            let change = self.watch.title(title);
            self.record(ms, change);
        }

        /// The keeper's 1 s ticks up to `to`.
        fn ticks(&mut self, to: u64) {
            for ms in (1000..=to).step_by(1000) {
                let change = self.watch.tick(self.at(ms));
                self.record(ms, change);
            }
        }
    }

    #[test]
    fn n06_input_marks_keep_the_last_input_and_count_submits() {
        let t0 = Instant::now();
        let marks = InputMarks::new(t0);
        assert_eq!(
            marks.seen(),
            InputSeen {
                last: None,
                submits: 0
            }
        );
        marks.input(t0 + MS * 5, Some(b"h"));
        marks.input(t0 + MS * 9, None);
        assert_eq!(marks.seen().last, Some(t0 + MS * 9));
        assert_eq!(marks.seen().submits, 0);
        marks.input(t0 + MS * 12, Some(b"fix it\r"));
        marks.input(t0 + MS * 13, Some(b"\x1b[13;1u"));
        assert_eq!(marks.seen().submits, 2);
    }

    /// Recorded: an agent (no title) prints for 4 s after the user's prompt, then stops.
    #[test]
    fn n06_sustained_output_after_a_prompt_is_working_then_quiet_is_idle() {
        let mut rig = Rig::new(None);
        for (i, c) in "fix the bug".chars().enumerate() {
            let ms = 100 + 50 * i as u64;
            rig.key(ms, &c.to_string());
            rig.out(ms + 10); // the echo
        }
        rig.key(700, "\r");
        rig.out(720); // the echo of Enter
        // The spinner and the answer, every 100 ms until 4.9 s.
        rig.stream(900, 4900, 100);
        rig.ticks(9000);
        // Working one sustained second after the first output past the echo window (1 s).
        // Idle at the first tick 2 s after the last output (4.9 s → 7 s).
        assert_eq!(rig.changes, [(2000, true), (7000, false)]);
    }

    #[test]
    fn n06_the_echo_of_typing_is_never_working() {
        let mut rig = Rig::new(None);
        rig.key(0, "go\r");
        // The user keeps typing for 5 s; every chunk is the echo of a key.
        for ms in (500..5500).step_by(120) {
            rig.key(ms, "x");
            rig.out(ms + 40);
        }
        rig.ticks(9000);
        assert_eq!(rig.changes, []);
    }

    #[test]
    fn n06_short_bursts_are_not_working() {
        let mut rig = Rig::new(None);
        rig.key(0, "\r");
        // Redraws: 600 ms of output, a 1.5 s pause, 600 ms again.
        rig.stream(400, 1000, 100);
        rig.stream(2500, 3100, 100);
        rig.ticks(6000);
        assert_eq!(rig.changes, []);
    }

    #[test]
    fn n06_start_up_and_a_resumed_history_never_count_until_a_submit() {
        let mut rig = Rig::new(None);
        // A resumed session prints its history for 3 s; focus reports and terminal replies
        // come in meanwhile (no Enter in them).
        rig.key(200, "\x1b[I");
        rig.key(250, "\x1b[?1;2c");
        rig.stream(500, 3500, 50);
        rig.ticks(6000);
        assert_eq!(rig.changes, []);
        // The user asks something: now it counts.
        rig.key(10_000, "next\r");
        rig.stream(10_400, 12_000, 100);
        assert_eq!(rig.changes, [(11_400, true)]);
    }

    #[test]
    fn n06_typing_while_it_works_keeps_it_working_until_it_goes_quiet() {
        let mut rig = Rig::new(None);
        rig.key(0, "\r");
        rig.stream(400, 3000, 100);
        // The user types a next message while it works; its own output goes on until 6 s.
        for ms in (3000..6000).step_by(300) {
            rig.key(ms, "y");
        }
        rig.stream(3050, 6000, 100);
        rig.ticks(10_000);
        // (Its output in the echo window of a key still keeps a working agent working.)
        assert_eq!(rig.changes, [(1400, true), (8000, false)]);
    }

    /// Recorded from Claude Code 2.1.292: `✳ <name>` idle, `◐`/`◑` every 960 ms while busy.
    #[test]
    fn n06_the_agents_title_decides_once_it_matched() {
        let mut rig = Rig::new(Some("^[◐◑] "));
        // The shell's own title for the command, then the agent's idle title: no change.
        rig.title(50, "Command Prompt - claude --session-id 1");
        rig.title(800, "\u{2733} Claude Code");
        rig.key(2000, "fix it\r");
        rig.title(2100, "\u{25d0} Fix the login bug");
        rig.title(3060, "\u{25d1} Fix the login bug");
        // Its output is no longer looked at: a 5 s pause in it changes nothing.
        rig.stream(2200, 2600, 100);
        rig.ticks(9000);
        rig.title(9500, "\u{25d0} Fix the login bug");
        rig.title(9800, "\u{2733} Fix the login bug");
        // Output after it went idle (a redraw, typing) doesn't make it work.
        rig.key(10_000, "\r");
        rig.stream(10_400, 13_000, 100);
        assert_eq!(rig.changes, [(2100, true), (9800, false)]);
    }

    #[test]
    fn n06_without_a_matching_title_activity_decides() {
        // Claude Code with CLAUDE_CODE_DISABLE_TERMINAL_TITLE: titles never match.
        let mut rig = Rig::new(Some("^[◐◑] "));
        rig.title(50, "Command Prompt - claude");
        rig.key(1000, "\r");
        rig.stream(1400, 3000, 100);
        rig.ticks(6000);
        assert_eq!(rig.changes, [(2400, true), (5000, false)]);
    }

    #[test]
    fn n06_an_agent_that_ends_while_working_is_idle() {
        let mut rig = Rig::new(Some("^[◐◑] "));
        rig.title(100, "\u{25d0} x");
        assert!(rig.watch.working());
        assert_eq!(rig.watch.ended(), Some(false));
        assert_eq!(rig.watch.ended(), None);
    }
}
