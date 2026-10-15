//! N-02: keystrokes in the order they were typed. `pty_write` is an async IPC command, so two
//! calls can run in either order, and Tauri may deliver one twice. Each write carries a sequence
//! number (1, 2, 3… per attachment); this writes each number once, in order, holding a write
//! that arrives early until the ones before it are in.
//!
//! A number that never arrives (its call failed) must not hold the keyboard forever: once a gap
//! is older than [`GAP_TIMEOUT`] or more than [`MAX_WAITING`] writes wait behind it, it is
//! skipped.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use super::types::AttachmentId;

/// How long a missing write is waited for.
pub(crate) const GAP_TIMEOUT: Duration = Duration::from_secs(1);
/// How many writes may wait behind a missing one.
pub(crate) const MAX_WAITING: usize = 256;

#[derive(Debug)]
pub(crate) struct InputOrder {
    attachment: AttachmentId,
    /// The next sequence number to write.
    next: u32,
    /// Writes that arrived before `next`.
    waiting: BTreeMap<u32, Vec<u8>>,
    /// Since when `next` has been missing while later writes wait.
    gap_since: Option<Instant>,
    gap_timeout: Duration,
    max_waiting: usize,
}

impl InputOrder {
    pub(crate) fn new(attachment: AttachmentId) -> Self {
        Self::with_limits(attachment, GAP_TIMEOUT, MAX_WAITING)
    }

    fn with_limits(attachment: AttachmentId, gap_timeout: Duration, max_waiting: usize) -> Self {
        Self {
            attachment,
            next: 1,
            waiting: BTreeMap::new(),
            gap_since: None,
            gap_timeout,
            max_waiting,
        }
    }

    /// A new view took over: its numbering starts again at 1; whatever the last one left
    /// waiting is dropped.
    pub(crate) fn restart(&mut self, attachment: AttachmentId) {
        *self = Self::with_limits(attachment, self.gap_timeout, self.max_waiting);
    }

    /// The writes that can go to the shell now, in order, after `data` (number `seq` of
    /// `attachment`) arrived. Nothing for another attachment's write or a repeated number.
    pub(crate) fn accept(
        &mut self,
        attachment: AttachmentId,
        seq: u32,
        data: Vec<u8>,
        now: Instant,
    ) -> Vec<Vec<u8>> {
        if attachment != self.attachment || seq < self.next || self.waiting.contains_key(&seq) {
            return Vec::new();
        }
        self.waiting.insert(seq, data);
        if let Some((&first, _)) = self.waiting.first_key_value()
            && first != self.next
        {
            let since = *self.gap_since.get_or_insert(now);
            if now.saturating_duration_since(since) < self.gap_timeout
                && self.waiting.len() <= self.max_waiting
            {
                return Vec::new();
            }
            tracing::warn!(
                missing = first - self.next,
                "N-02: keystrokes lost on the way; continuing without them"
            );
            self.next = first;
        }
        let mut ready = Vec::new();
        while let Some(data) = self.waiting.remove(&self.next) {
            ready.push(data);
            self.next = self.next.wrapping_add(1);
        }
        // Writes still waiting are behind a new gap.
        self.gap_since = (!self.waiting.is_empty()).then_some(now);
        ready
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex, mpsc};

    use super::*;

    const A: AttachmentId = AttachmentId(1);
    const NONE: [Vec<u8>; 0] = [];

    fn bytes(n: u32) -> Vec<u8> {
        n.to_le_bytes().to_vec()
    }

    #[test]
    fn n02_writes_go_out_in_order_once() {
        let now = Instant::now();
        let mut order = InputOrder::new(A);
        assert_eq!(order.accept(A, 2, bytes(2), now), NONE);
        assert_eq!(order.accept(A, 3, bytes(3), now), NONE);
        assert_eq!(
            order.accept(A, 1, bytes(1), now),
            [bytes(1), bytes(2), bytes(3)]
        );
        // Repeats (delivered twice) and another view's writes are dropped.
        assert_eq!(order.accept(A, 2, bytes(2), now), NONE);
        assert_eq!(order.accept(AttachmentId(9), 4, bytes(4), now), NONE);
        assert_eq!(order.accept(A, 4, bytes(4), now), [bytes(4)]);
        // A new view numbers from 1 again.
        order.restart(AttachmentId(2));
        assert_eq!(order.accept(A, 5, bytes(5), now), NONE);
        assert_eq!(order.accept(AttachmentId(2), 1, bytes(1), now), [bytes(1)]);
    }

    #[test]
    fn n02_a_lost_write_is_skipped_after_the_timeout() {
        let start = Instant::now();
        let mut order = InputOrder::new(A);
        assert_eq!(order.accept(A, 2, bytes(2), start), NONE);
        let later = start + GAP_TIMEOUT;
        assert_eq!(order.accept(A, 3, bytes(3), later), [bytes(2), bytes(3)]);
        // The lost one arriving late is not written out of order.
        assert_eq!(order.accept(A, 1, bytes(1), later), NONE);
    }

    #[test]
    fn n02_too_many_waiting_writes_skip_the_gap() {
        let now = Instant::now();
        let mut order = InputOrder::new(A);
        for seq in 2..=u32::try_from(MAX_WAITING).unwrap() + 1 {
            assert_eq!(order.accept(A, seq, bytes(seq), now), NONE);
        }
        let last = u32::try_from(MAX_WAITING).unwrap() + 2;
        let ready = order.accept(A, last, bytes(last), now);
        assert_eq!(ready.len(), MAX_WAITING + 1);
        assert_eq!(ready.first(), Some(&bytes(2)));
    }

    /// 10,000 single keystrokes from 8 threads in any order, some delivered twice, come out
    /// exactly once each, in order (no limits here: a thread may run far ahead of another).
    #[test]
    fn n02_ten_thousand_concurrent_writes_arrive_exactly_in_order() {
        const COUNT: u32 = 10_000;
        let order = Arc::new(Mutex::new(InputOrder::with_limits(
            A,
            Duration::MAX,
            usize::MAX,
        )));
        let (tx, rx) = mpsc::channel();
        let threads: Vec<_> = (0..8u32)
            .map(|lane| {
                let order = Arc::clone(&order);
                let tx = tx.clone();
                std::thread::spawn(move || {
                    // Each lane sends its numbers backwards, then repeats every tenth one.
                    let mine: Vec<u32> = (1..=COUNT).rev().filter(|n| n % 8 == lane).collect();
                    for &seq in mine.iter().chain(mine.iter().filter(|n| *n % 10 == 0)) {
                        let mut order = order.lock().unwrap();
                        for data in order.accept(A, seq, bytes(seq), Instant::now()) {
                            tx.send(data).unwrap();
                        }
                    }
                })
            })
            .collect();
        drop(tx);
        for thread in threads {
            thread.join().unwrap();
        }
        let written: Vec<Vec<u8>> = rx.iter().collect();
        let expected: Vec<Vec<u8>> = (1..=COUNT).map(bytes).collect();
        assert_eq!(written, expected);
    }
}
