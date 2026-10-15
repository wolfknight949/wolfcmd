//! N-05: copies of the last good `workspaces.json`, so a damaged or lost file never costs the
//! user their workspaces. At each start a good file is copied to `workspaces.json.bak`, and once
//! a day to `backups/workspaces-<YYYY-MM-DD>.json` (UTC); the newest [`DAILY_KEPT`] daily
//! copies are kept. A file that can't be used is replaced by the newest copy that parses.

use std::path::{Path, PathBuf};

use crate::document::Document;

/// How many daily copies are kept (one per day the app started).
pub(crate) const DAILY_KEPT: usize = 7;
const DAILY_DIR: &str = "backups";
const DAILY_PREFIX: &str = "workspaces-";
const DAILY_SUFFIX: &str = ".json";

/// The backups of the state file at `path` (`<dir>/workspaces.json`).
#[derive(Debug, Clone)]
pub(crate) struct Backups {
    last: PathBuf,
    daily_dir: PathBuf,
}

impl Backups {
    pub(crate) fn of(path: &Path) -> Self {
        let dir = path.parent().unwrap_or_else(|| Path::new("."));
        let mut last = path.as_os_str().to_owned();
        last.push(".bak");
        Self {
            last: PathBuf::from(last),
            daily_dir: dir.join(DAILY_DIR),
        }
    }

    /// `workspaces.json.bak`, the last good file at the latest start.
    pub(crate) fn last(&self) -> &Path {
        &self.last
    }

    /// The daily copy of the day `days` (days since 1970-01-01).
    pub(crate) fn daily(&self, days: u64) -> PathBuf {
        let (year, month, day) = civil_date(days);
        self.daily_dir.join(format!(
            "{DAILY_PREFIX}{year:04}-{month:02}-{day:02}{DAILY_SUFFIX}"
        ))
    }

    /// Keeps `bytes` (a good file's) as the latest copy and, once a day, as that day's copy;
    /// drops daily copies beyond the newest [`DAILY_KEPT`]. Failures are logged: a backup
    /// never stops the start.
    pub(crate) fn keep(&self, bytes: &[u8], today: u64) {
        if let Err(error) = wcmd_config::fs::write_atomic(&self.last, bytes) {
            tracing::warn!(%error, "N-05: could not write workspaces.json.bak");
        }
        let daily = self.daily(today);
        if !daily.exists() {
            let written = std::fs::create_dir_all(&self.daily_dir)
                .and_then(|()| wcmd_config::fs::write_atomic(&daily, bytes));
            if let Err(error) = written {
                tracing::warn!(%error, "N-05: could not write the daily backup");
            }
        }
        for old in self.daily_copies().into_iter().skip(DAILY_KEPT) {
            if let Err(error) = std::fs::remove_file(&old) {
                tracing::warn!(%error, path = %old.display(), "N-05: could not drop an old backup");
            }
        }
    }

    /// The newest copy that parses (and is not from a newer WolfCmd): the latest copy first,
    /// then the daily ones, newest first.
    pub(crate) fn newest_good(&self) -> Option<(PathBuf, Document)> {
        std::iter::once(self.last.clone())
            .chain(self.daily_copies())
            .find_map(|path| {
                let document = parse_current(&std::fs::read(&path).ok()?)?;
                Some((path, document))
            })
    }

    /// The daily copies, newest first (their names sort by date).
    fn daily_copies(&self) -> Vec<PathBuf> {
        let Ok(entries) = std::fs::read_dir(&self.daily_dir) else {
            return Vec::new();
        };
        let mut copies: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .filter(|entry| {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                name.starts_with(DAILY_PREFIX) && name.ends_with(DAILY_SUFFIX)
            })
            .map(|entry| entry.path())
            .collect();
        copies.sort_unstable_by(|a, b| b.cmp(a));
        copies
    }
}

/// A document this WolfCmd can use: valid UTF-8 JSON of a format it knows (an older one
/// migrated, `migrate.rs`), normalized.
pub(crate) fn parse_current(bytes: &[u8]) -> Option<Document> {
    crate::migrate::parse(bytes).map(|parsed| parsed.document)
}

/// Days since 1970-01-01 (UTC) now.
pub(crate) fn today() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() / 86_400)
}

/// The UTC calendar date of `days` since 1970-01-01 (H. Hinnant's `civil_from_days`).
fn civil_date(days: u64) -> (u64, u64, u64) {
    let z = days + 719_468;
    let era = z / 146_097;
    let day_of_era = z % 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let mp = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = year_of_era + era * 400 + u64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn n05_civil_dates() {
        assert_eq!(civil_date(0), (1970, 1, 1));
        assert_eq!(civil_date(11_016), (2000, 2, 29));
        assert_eq!(civil_date(20_740), (2026, 10, 14));
    }
}
