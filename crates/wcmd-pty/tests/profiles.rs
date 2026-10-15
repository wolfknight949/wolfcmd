//! Discovery on the real machine (Windows only).
#![cfg(windows)]

use std::time::Instant;

use wcmd_pty::{default_profile_preferring, find_profile, installed_profiles};

#[test]
fn every_windows_has_windows_powershell_and_cmd() {
    let ids: Vec<_> = installed_profiles().iter().map(|p| p.id.as_str()).collect();
    assert!(ids.contains(&"windows-powershell"), "{ids:?}");
    assert!(ids.contains(&"cmd"), "{ids:?}");
    assert_eq!(default_profile_preferring(None).id, ids[0]);
    assert_eq!(
        find_profile("cmd").map(|p| p.name),
        Some("Command Prompt".to_owned())
    );
    assert_eq!(find_profile("no-such-shell"), None);
}

#[test]
fn discovery_is_fast() {
    // A fresh discovery (the cached one may already exist in this process).
    let start = Instant::now();
    let _ = installed_profiles();
    assert!(
        start.elapsed().as_millis() < 50,
        "took {:?}",
        start.elapsed()
    );
}

#[test]
fn profile_programs_exist() {
    for profile in installed_profiles() {
        assert!(
            std::path::Path::new(&profile.program).is_file(),
            "{} → {}",
            profile.id,
            profile.program
        );
    }
}
