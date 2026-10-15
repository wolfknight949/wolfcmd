//! Shell output → screen (ARCHITECTURE "Key data flows"): coalesce PTY output into at most
//! one IPC message per frame, so heavy output can't flood IPC, while keeping interactive
//! echo instant: after an idle period the first chunk is sent with no wait.

use std::sync::mpsc::{Receiver, RecvTimeoutError, TryRecvError};
use std::time::{Duration, Instant};

/// One display frame at 60 Hz.
pub(crate) const FRAME: Duration = Duration::from_millis(16);

/// Flush early once a batch gets this big, to bound per-message memory and parse time.
const MAX_BATCH: usize = 1024 * 1024;

/// Runs until `rx` disconnects (after a final flush) or `flush` returns `false` (the
/// receiver is gone). Chunks are concatenated in order.
pub(crate) fn run(rx: &Receiver<Vec<u8>>, frame: Duration, mut flush: impl FnMut(Vec<u8>) -> bool) {
    let mut last_flush: Option<Instant> = None;
    while let Ok(mut batch) = rx.recv() {
        // Within a frame of the previous flush, keep gathering until that frame ends.
        let deadline = last_flush.map(|at| at + frame);
        let disconnected = gather(rx, &mut batch, deadline);
        if !flush(batch) {
            return;
        }
        last_flush = Some(Instant::now());
        if disconnected {
            return;
        }
    }
}

/// Appends queued chunks to `batch`; waits for more until `deadline` if there is one.
/// Returns `true` if the sender disconnected.
fn gather(rx: &Receiver<Vec<u8>>, batch: &mut Vec<u8>, deadline: Option<Instant>) -> bool {
    while batch.len() < MAX_BATCH {
        let next = match rx.try_recv() {
            Ok(chunk) => Ok(chunk),
            Err(TryRecvError::Disconnected) => return true,
            Err(TryRecvError::Empty) => {
                let Some(deadline) = deadline else {
                    return false;
                };
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    return false;
                }
                rx.recv_timeout(left)
            }
        };
        match next {
            Ok(chunk) => batch.extend_from_slice(&chunk),
            Err(RecvTimeoutError::Timeout) => return false,
            Err(RecvTimeoutError::Disconnected) => return true,
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use super::*;

    const LONG: Duration = Duration::from_secs(3600);
    const WAIT: Duration = Duration::from_secs(5);

    #[test]
    fn t03_queued_burst_is_sent_as_one_batch() {
        let (tx, rx) = mpsc::channel();
        for chunk in [b"ab".to_vec(), b"cd".to_vec(), b"ef".to_vec()] {
            tx.send(chunk).unwrap();
        }
        drop(tx);
        let mut batches = Vec::new();
        run(&rx, LONG, |b| {
            batches.push(b);
            true
        });
        assert_eq!(batches, [b"abcdef".to_vec()]);
    }

    #[test]
    fn t03_idle_output_is_sent_without_waiting_for_a_frame() {
        let (tx, rx) = mpsc::channel();
        let (out_tx, out_rx) = mpsc::channel();
        // A frame of an hour: if the first chunk waited for it, this test would time out.
        let worker = std::thread::spawn(move || run(&rx, LONG, |b| out_tx.send(b).is_ok()));
        tx.send(b"echo".to_vec()).unwrap();
        assert_eq!(out_rx.recv_timeout(WAIT).unwrap(), b"echo");
        drop(tx);
        worker.join().unwrap();
    }

    #[test]
    fn t03_output_within_a_frame_of_a_flush_is_coalesced() {
        let (tx, rx) = mpsc::channel();
        let (out_tx, out_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || run(&rx, LONG, |b| out_tx.send(b).is_ok()));
        tx.send(b"1".to_vec()).unwrap();
        assert_eq!(out_rx.recv_timeout(WAIT).unwrap(), b"1");
        // These arrive within the (hour-long) frame after the first flush, so they wait
        // for it to end, or for the sender to disconnect, and are sent together.
        tx.send(b"2".to_vec()).unwrap();
        tx.send(b"3".to_vec()).unwrap();
        drop(tx);
        assert_eq!(out_rx.recv_timeout(WAIT).unwrap(), b"23");
        worker.join().unwrap();
    }

    #[test]
    fn t03_stops_when_the_receiver_is_gone() {
        let (tx, rx) = mpsc::channel();
        tx.send(b"x".to_vec()).unwrap();
        let mut calls = 0;
        run(&rx, LONG, |_| {
            calls += 1;
            false
        });
        assert_eq!(calls, 1);
    }

    #[test]
    fn t03_large_output_is_split_at_the_batch_cap() {
        let (tx, rx) = mpsc::channel();
        for _ in 0..3 {
            tx.send(vec![0u8; MAX_BATCH / 2 + 1]).unwrap();
        }
        drop(tx);
        let mut sizes = Vec::new();
        run(&rx, Duration::ZERO, |b| {
            sizes.push(b.len());
            true
        });
        assert_eq!(sizes, [MAX_BATCH + 2, MAX_BATCH / 2 + 1]);
    }
}
