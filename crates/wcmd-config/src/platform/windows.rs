//! The Windows half of [`crate::fs`].

use std::path::Path;

use windows::Win32::Storage::FileSystem::{
    MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
};
use windows::core::HSTRING;

/// Moves `from` over `to`, returning only once the move is on the disk
/// (`MOVEFILE_WRITE_THROUGH`), so a power cut right after never finds the new name without
/// its contents.
pub(crate) fn move_write_through(from: &Path, to: &Path) -> std::io::Result<()> {
    let from = HSTRING::from(from.as_os_str());
    let to = HSTRING::from(to.as_os_str());
    // SAFETY: both arguments are valid NUL-terminated wide strings that outlive the call;
    // MoveFileExW does not keep them.
    unsafe {
        MoveFileExW(
            &from,
            &to,
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(|e| std::io::Error::from_raw_os_error(e.code().0 & 0xFFFF))
}
