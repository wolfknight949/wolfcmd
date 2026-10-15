//! ConPTY repaints after a
//! resize. The patched portable-pty in `third_party/` creates the pseudo console without
//! `PSEUDOCONSOLE_RESIZE_QUIRK`, and the workspace uses it.

/// The flags `PsuedoCon::new` passes to `CreatePseudoConsole`, without comment lines.
fn create_flags() -> String {
    let source = include_str!("../../../third_party/portable-pty/src/win/psuedocon.rs");
    let call = source
        .split("(CONPTY.CreatePseudoConsole)(")
        .nth(1)
        .expect("PsuedoCon::new calls CreatePseudoConsole");
    let call = &call[..call.find("&mut con").expect("the handle argument")];
    call.lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn conpty_repaints_after_a_resize() {
    let flags = create_flags();
    assert!(!flags.contains("PSEUDOCONSOLE_RESIZE_QUIRK"), "{flags}");
    assert!(flags.contains("PSEUDOCONSOLE_WIN32_INPUT_MODE"), "{flags}");
}

#[test]
fn the_workspace_uses_the_patched_portable_pty() {
    let manifest = include_str!("../../../Cargo.toml");
    assert!(manifest.contains(r#"portable-pty = { path = "third_party/portable-pty" }"#));
    assert!(manifest.contains(r#"exclude = ["third_party/portable-pty"]"#));
}
