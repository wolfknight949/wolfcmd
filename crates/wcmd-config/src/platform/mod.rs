//! Platform code (the only `unsafe` in this crate).

#[cfg(windows)]
pub(crate) mod windows;
