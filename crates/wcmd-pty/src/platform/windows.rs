//! Registry reads for profile discovery.

use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, RRF_RT_REG_SZ, RegCloseKey,
    RegEnumKeyExW, RegGetValueW, RegOpenKeyExW,
};
use windows_core::{HSTRING, PWSTR};

use crate::profiles::Hive;

fn root(hive: Hive) -> HKEY {
    match hive {
        Hive::CurrentUser => HKEY_CURRENT_USER,
        Hive::LocalMachine => HKEY_LOCAL_MACHINE,
    }
}

/// A string (`REG_SZ`) value, or `None` if the key or value doesn't exist.
pub(crate) fn registry_string(hive: Hive, key: &str, value: &str) -> Option<String> {
    let key = HSTRING::from(key);
    let value = HSTRING::from(value);
    let mut bytes = 0u32;
    // SAFETY: first call only queries the size; the second writes into a buffer of exactly
    // that size. All pointers outlive the calls.
    unsafe {
        if RegGetValueW(
            root(hive),
            &key,
            &value,
            RRF_RT_REG_SZ,
            None,
            None,
            Some(&raw mut bytes),
        ) != ERROR_SUCCESS
        {
            return None;
        }
        let mut buf = vec![0u16; usize::try_from(bytes).ok()? / 2 + 1];
        if RegGetValueW(
            root(hive),
            &key,
            &value,
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr().cast()),
            Some(&raw mut bytes),
        ) != ERROR_SUCCESS
        {
            return None;
        }
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..len]))
    }
}

/// Names of the direct subkeys of `key` (empty if it doesn't exist).
pub(crate) fn registry_subkeys(hive: Hive, key: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut handle = HKEY::default();
    // SAFETY: the opened handle is closed before returning; the name buffer outlives each call.
    unsafe {
        if RegOpenKeyExW(
            root(hive),
            &HSTRING::from(key),
            None,
            KEY_READ,
            &raw mut handle,
        ) != ERROR_SUCCESS
        {
            return names;
        }
        for index in 0.. {
            let mut buf = [0u16; 256];
            let mut len = u32::try_from(buf.len()).unwrap_or(0);
            let result = RegEnumKeyExW(
                handle,
                index,
                Some(PWSTR(buf.as_mut_ptr())),
                &raw mut len,
                None,
                None,
                None,
                None,
            );
            if result != ERROR_SUCCESS {
                break;
            }
            names.push(String::from_utf16_lossy(
                &buf[..usize::try_from(len).unwrap_or(0)],
            ));
        }
        let _ = RegCloseKey(handle);
    }
    names
}
