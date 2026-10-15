//! N-02: the unfinished end of the output stream. A read can end inside an escape sequence or a
//! UTF-8 character; the VT parser keeps that half in its state, where a replay can't reach it.
//! So the bytes of an unfinished trailing sequence are kept here and a replay ends with them:
//! the emulator taking over then reads the rest of the sequence as the rest of it, not as text.

/// An unfinished sequence longer than this (a runaway OSC) is given up on.
const MAX_TAIL: usize = 64 * 1024;

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;

#[derive(Debug, Default)]
pub(crate) struct Tail {
    bytes: Vec<u8>,
}

impl Tail {
    /// The bytes of the sequence or character the stream ends inside of (empty when it ends
    /// between two).
    pub(crate) fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// Follows the stream past `chunk`.
    pub(crate) fn feed(&mut self, chunk: &[u8]) {
        if let Some(esc) = chunk.iter().rposition(|&b| b == ESC) {
            // A new sequence starts here; anything unfinished before it was cut off by it.
            self.bytes.clear();
            self.bytes.extend_from_slice(&chunk[esc..]);
        } else if self.bytes.first() == Some(&ESC) {
            self.bytes.extend_from_slice(chunk);
        } else {
            // Plain text: at most the start of a character carries over.
            let keep = self.bytes.len().min(4);
            let mut text = self.bytes.split_off(self.bytes.len() - keep);
            text.extend_from_slice(&chunk[chunk.len().saturating_sub(4)..]);
            self.bytes = text;
        }
        let unfinished = if self.bytes.first() == Some(&ESC) {
            if sequence_unfinished(&self.bytes) {
                self.bytes.len()
            } else {
                partial_char(&self.bytes)
            }
        } else {
            partial_char(&self.bytes)
        };
        if unfinished > MAX_TAIL {
            self.bytes.clear();
        } else {
            self.bytes.drain(..self.bytes.len() - unfinished);
        }
    }
}

/// Whether `seq` (an ESC and what follows it, with no other ESC) is still waiting for its end.
fn sequence_unfinished(seq: &[u8]) -> bool {
    let Some(&kind) = seq.get(1) else {
        return true;
    };
    let rest = &seq[2..];
    match kind {
        // CSI: parameters and intermediates, then a final byte.
        b'[' => !rest.iter().any(|b| (0x40..=0x7e).contains(b)),
        // OSC, DCS, APC, PM, SOS: a string ended by BEL or ST (whose ESC would be the last one).
        b']' | b'P' | b'_' | b'^' | b'X' => !rest.contains(&BEL),
        // Intermediates, then a final byte.
        0x20..=0x2f => !rest.iter().any(|b| !(0x20..=0x2f).contains(b)),
        _ => false,
    }
}

/// How many bytes at the end of `bytes` are the start of an unfinished UTF-8 character.
fn partial_char(bytes: &[u8]) -> usize {
    let len = bytes.len();
    for back in 1..=len.min(3) {
        let byte = bytes[len - back];
        if byte & 0xc0 != 0x80 {
            let needed = match byte {
                0xc0..=0xdf => 2,
                0xe0..=0xef => 3,
                0xf0..=0xf7 => 4,
                _ => 1,
            };
            return if back < needed { back } else { 0 };
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn after(chunks: &[&[u8]]) -> Vec<u8> {
        let mut tail = Tail::default();
        for chunk in chunks {
            tail.feed(chunk);
        }
        tail.bytes().to_vec()
    }

    #[test]
    fn n02_finished_output_leaves_no_tail() {
        assert_eq!(after(&[b"plain text\r\n"]), b"");
        assert_eq!(after(&[b"\x1b[31mred\x1b[0m"]), b"");
        assert_eq!(after(&[b"\x1b]0;title\x07"]), b"");
        assert_eq!(after(&[b"\x1b]8;;http://x\x1b\\link"]), b"");
        assert_eq!(after(&["é✓".as_bytes()]), b"");
        assert_eq!(after(&[b"\x1b(B"]), b"");
    }

    #[test]
    fn n02_an_unfinished_sequence_is_kept_across_chunks() {
        assert_eq!(after(&[b"text\x1b[3"]), b"\x1b[3");
        assert_eq!(after(&[b"text\x1b[3", b"8;5"]), b"\x1b[38;5");
        assert_eq!(after(&[b"text\x1b[3", b"8;5", b";1m"]), b"");
        assert_eq!(after(&[b"\x1b]0;long ", b"title"]), b"\x1b]0;long title");
        assert_eq!(after(&[b"x\x1b"]), b"\x1b");
        assert_eq!(after(&[b"\x1b("]), b"\x1b(");
    }

    #[test]
    fn n02_a_split_character_is_kept() {
        let check = "✓".as_bytes();
        assert_eq!(after(&[&check[..2]]), &check[..2]);
        assert_eq!(after(&[&check[..1], &check[1..2]]), &check[..2]);
        assert_eq!(after(&[&check[..1], &check[1..]]), b"");
        assert_eq!(after(&[b"\x1b[0m", &check[..1]]), &check[..1]);
    }

    #[test]
    fn n02_a_runaway_sequence_is_given_up() {
        let mut tail = Tail::default();
        tail.feed(b"\x1b]52;c;");
        tail.feed(&vec![b'A'; MAX_TAIL]);
        assert_eq!(tail.bytes(), b"");
    }
}
