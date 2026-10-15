//! OS integration. `unsafe` is only allowed below this module.

#[cfg(windows)]
mod windows;

#[cfg(windows)]
pub(crate) use windows::{registry_string, registry_subkeys};

#[cfg(not(windows))]
pub(crate) fn registry_string(
    _hive: crate::profiles::Hive,
    _key: &str,
    _value: &str,
) -> Option<String> {
    None
}

#[cfg(not(windows))]
pub(crate) fn registry_subkeys(_hive: crate::profiles::Hive, _key: &str) -> Vec<String> {
    Vec::new()
}
