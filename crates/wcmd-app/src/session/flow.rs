//! Output flow control. The UI acknowledges output once xterm.js
//! has parsed it; when too much is unacknowledged the reader stops reading, ConPTY's buffer
//! fills and the shell's writes block. Heavy output then runs at render speed instead of
//! piling up in memory, and the UI never drowns.
//!
//! N-01: while the window is hidden to the tray the page may acknowledge slowly (a hidden web
//! view is throttled), so the reader never pauses then ([`FlowControl::set_background`]): an
//! agent in the tray never stalls. The output thread stops sending once the view is
//! [`HIGH_WATERMARK`] behind ([`FlowControl::may_send`]), so what waits for the page stays
//! bounded, and that view catches up from the screen state when the window shows again.

use std::sync::{Condvar, Mutex, PoisonError};

/// Pause reading once this much output is sent but not yet processed by the UI. 8 MiB measured
/// ~35 % faster than 2 MiB for plain-text floods at a negligible memory cost.
pub(crate) const HIGH_WATERMARK: usize = 8 * 1024 * 1024;
/// Resume once the backlog drops below this.
pub(crate) const LOW_WATERMARK: usize = HIGH_WATERMARK / 2;

#[derive(Debug, Default)]
struct State {
    unacked: usize,
    /// Nobody will acknowledge any more (session ended or the UI went away).
    closed: bool,
    /// The reader is waiting for the UI to catch up.
    paused: bool,
    /// N-01: the window is hidden to the tray: the reader never waits for the view.
    background: bool,
}

#[derive(Debug, Default)]
pub(crate) struct FlowControl {
    state: Mutex<State>,
    changed: Condvar,
}

impl FlowControl {
    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Records output handed to the UI.
    pub(crate) fn sent(&self, bytes: usize) {
        self.state().unacked += bytes;
    }

    /// Records output the UI has processed.
    pub(crate) fn ack(&self, bytes: usize) {
        let mut state = self.state();
        state.unacked = state.unacked.saturating_sub(bytes);
        self.changed.notify_all();
    }

    /// N-02: the view changed (detached, or a new one attached): what the last one never
    /// acknowledged no longer counts, and a paused reader goes on.
    pub(crate) fn reset(&self) {
        self.state().unacked = 0;
        self.changed.notify_all();
    }

    /// Stops flow control for good, releasing a waiting reader.
    pub(crate) fn close(&self) {
        self.state().closed = true;
        self.changed.notify_all();
    }

    /// Blocks the reader while the backlog is at or above the high watermark, until it
    /// drops below the low one (hysteresis avoids flapping) or flow control is closed.
    pub(crate) fn wait_for_capacity(&self) {
        let mut state = self.state();
        if state.closed || state.background || state.unacked < HIGH_WATERMARK {
            return;
        }
        state.paused = true;
        tracing::trace!(
            unacked = state.unacked,
            "output paused until the UI catches up"
        );
        let mut state = self
            .changed
            .wait_while(state, |s| {
                !s.closed && !s.background && s.unacked >= LOW_WATERMARK
            })
            .unwrap_or_else(PoisonError::into_inner);
        state.paused = false;
    }

    /// N-01: the window is hidden to the tray (`true`) or shown again. Hidden, the reader never
    /// waits for the view (a paused one goes on at once).
    pub(crate) fn set_background(&self, on: bool) {
        self.state().background = on;
        self.changed.notify_all();
    }

    /// N-01: whether more output may go to the view: always while the window is shown (the
    /// reader pauses instead); hidden, only while the view is less than [`HIGH_WATERMARK`]
    /// behind, so what waits for a throttled page stays bounded.
    pub(crate) fn may_send(&self) -> bool {
        let state = self.state();
        !state.background || state.unacked < HIGH_WATERMARK
    }

    /// What the view hasn't acknowledged yet.
    #[cfg(test)]
    pub(crate) fn unacked(&self) -> usize {
        self.state().unacked
    }

    /// Whether the reader is currently paused.
    #[cfg(test)]
    pub(crate) fn is_paused(&self) -> bool {
        self.state().paused
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::mpsc;
    use std::time::Duration;

    use super::*;

    const WAIT: Duration = Duration::from_secs(5);
    const BRIEF: Duration = Duration::from_millis(50);

    /// Waits (without sleeping) until the waiter thread is actually blocked.
    fn until_paused(flow: &FlowControl) {
        let deadline = std::time::Instant::now() + WAIT;
        while !flow.is_paused() {
            assert!(std::time::Instant::now() < deadline, "reader never paused");
            std::thread::yield_now();
        }
    }

    /// Runs `wait_for_capacity` on a thread and reports when it returns.
    fn waiter(flow: &Arc<FlowControl>) -> mpsc::Receiver<()> {
        let (tx, rx) = mpsc::channel();
        let flow = Arc::clone(flow);
        std::thread::spawn(move || {
            flow.wait_for_capacity();
            let _ = tx.send(());
        });
        rx
    }

    #[test]
    fn t04_below_the_high_watermark_reading_continues() {
        let flow = FlowControl::default();
        flow.sent(HIGH_WATERMARK - 1);
        flow.wait_for_capacity(); // returns immediately
    }

    #[test]
    fn t04_reader_pauses_until_the_ui_catches_up() {
        let flow = Arc::new(FlowControl::default());
        flow.sent(HIGH_WATERMARK);
        let released = waiter(&flow);
        until_paused(&flow);
        // Still blocked: the backlog is above the low watermark.
        flow.ack(HIGH_WATERMARK - LOW_WATERMARK); // backlog == LOW
        assert!(released.recv_timeout(BRIEF).is_err(), "resumed too early");
        flow.ack(1);
        released
            .recv_timeout(WAIT)
            .expect("reader resumes below the low watermark");
    }

    #[test]
    fn t04_close_releases_a_paused_reader() {
        let flow = Arc::new(FlowControl::default());
        flow.sent(HIGH_WATERMARK * 2);
        let released = waiter(&flow);
        until_paused(&flow);
        flow.close();
        released
            .recv_timeout(WAIT)
            .expect("close releases the reader");
        // And it never blocks again.
        flow.wait_for_capacity();
    }

    #[test]
    fn n02_reset_forgets_the_backlog_and_releases_the_reader() {
        let flow = Arc::new(FlowControl::default());
        flow.sent(HIGH_WATERMARK * 2);
        let released = waiter(&flow);
        until_paused(&flow);
        flow.reset();
        released
            .recv_timeout(WAIT)
            .expect("reset releases the reader");
        // Unlike close, flow control goes on from zero.
        flow.sent(HIGH_WATERMARK - 1);
        flow.wait_for_capacity();
    }

    #[test]
    fn n01_hidden_to_the_tray_the_reader_never_pauses() {
        let flow = Arc::new(FlowControl::default());
        flow.sent(HIGH_WATERMARK * 2);
        let released = waiter(&flow);
        until_paused(&flow);
        // Hiding releases a paused reader, and it never waits while hidden.
        flow.set_background(true);
        released
            .recv_timeout(WAIT)
            .expect("hiding releases the reader");
        flow.sent(HIGH_WATERMARK * 4);
        flow.wait_for_capacity();
        // Shown again, the usual backpressure is back.
        flow.set_background(false);
        let released = waiter(&flow);
        until_paused(&flow);
        flow.reset();
        released.recv_timeout(WAIT).expect("released");
    }

    #[test]
    fn n01_hidden_output_stops_going_to_a_view_that_fell_behind() {
        let flow = FlowControl::default();
        flow.sent(HIGH_WATERMARK * 2);
        // Shown: output always goes (the reader pauses instead).
        assert!(flow.may_send());
        flow.set_background(true);
        assert!(!flow.may_send());
        flow.ack(HIGH_WATERMARK + 1);
        assert!(flow.may_send());
    }

    #[test]
    fn t04_extra_acks_never_underflow() {
        let flow = FlowControl::default();
        flow.ack(10);
        flow.sent(5);
        flow.ack(100);
        flow.sent(HIGH_WATERMARK - 1);
        flow.wait_for_capacity(); // backlog is HIGH - 1, so no pause
    }
}
