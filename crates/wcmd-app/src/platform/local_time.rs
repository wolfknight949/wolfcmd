//! A moment as the user's wall-clock time, for the divider above a restored scrollback
//! ("── restored from 2026-10-12 18:05 ──"). Uses the time zone rules of that moment (summer
//! time included).

use windows::Win32::Foundation::{FILETIME, SYSTEMTIME};
use windows::Win32::System::Time::{FileTimeToSystemTime, SystemTimeToTzSpecificLocalTime};

use crate::session::WallClock;

/// Seconds from 1601-01-01 (the `FILETIME` epoch) to 1970-01-01.
const EPOCH_OFFSET: u64 = 11_644_473_600;

/// `unix_seconds` in the current time zone; `None` if Windows can't convert it.
pub(crate) fn local_time(unix_seconds: u64) -> Option<WallClock> {
    let ticks = unix_seconds
        .checked_add(EPOCH_OFFSET)?
        .checked_mul(10_000_000)?;
    let file = FILETIME {
        dwLowDateTime: u32::try_from(ticks & 0xFFFF_FFFF).ok()?,
        dwHighDateTime: u32::try_from(ticks >> 32).ok()?,
    };
    let mut utc = SYSTEMTIME::default();
    let mut local = SYSTEMTIME::default();
    // SAFETY: pointers to initialized locals that outlive both calls; no time zone argument
    // (the current one).
    unsafe {
        FileTimeToSystemTime(&raw const file, &raw mut utc).ok()?;
        SystemTimeToTzSpecificLocalTime(None, &raw const utc, &raw mut local).ok()?;
    }
    Some(WallClock {
        year: local.wYear,
        month: u8::try_from(local.wMonth).ok()?,
        day: u8::try_from(local.wDay).ok()?,
        hour: u8::try_from(local.wHour).ok()?,
        minute: u8::try_from(local.wMinute).ok()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_time_is_within_a_day_of_utc() {
        let local = local_time(1_760_000_000).expect("Windows converts it");
        // 2025-10-09 08:53 UTC: every time zone is between UTC-12 and UTC+14.
        assert!(
            (local.year, local.month, local.day) >= (2025, 10, 8)
                && (local.year, local.month, local.day) <= (2025, 10, 10)
        );
        assert!(local.minute < 60 && local.hour < 24);
    }
}
