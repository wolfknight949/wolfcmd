//! Puts Microsoft's ConPTY (`resources/conpty/<arch>/`) next to every binary and test
//! executable built in this target directory, so `portable-pty` side-loads it everywhere.

use std::path::{Path, PathBuf};

const FILES: [&str; 2] = ["conpty.dll", "OpenConsole.exe"];

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default());
    let vendored = manifest.join("../../resources/conpty");
    println!("cargo:rerun-if-changed={}", vendored.display());
    if std::env::var("CARGO_CFG_WINDOWS").is_err() {
        return;
    }
    let arch = match std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("x86_64") => "x64",
        Ok("aarch64") => "arm64",
        _ => {
            println!("cargo:warning=no vendored ConPTY for this architecture; using Windows' own");
            return;
        }
    };
    // OUT_DIR is target/<profile>/build/wcmd-pty-<hash>/out.
    let Some(profile_dir) = std::env::var_os("OUT_DIR")
        .map(PathBuf::from)
        .and_then(|out| out.ancestors().nth(3).map(Path::to_path_buf))
    else {
        return;
    };
    for dir in [
        profile_dir.clone(),
        profile_dir.join("deps"),
        profile_dir.join("examples"),
    ] {
        if std::fs::create_dir_all(&dir).is_err() {
            continue;
        }
        for file in FILES {
            let from = vendored.join(arch).join(file);
            // A running exe keeps these files locked; an existing identical copy is fine.
            if let Err(error) = copy_if_changed(&from, &dir.join(file)) {
                println!("cargo:warning=could not copy {}: {error}", from.display());
            }
        }
    }
}

fn copy_if_changed(from: &Path, to: &Path) -> std::io::Result<()> {
    let source = std::fs::read(from)?;
    if std::fs::read(to).ok().as_deref() == Some(source.as_slice()) {
        return Ok(());
    }
    std::fs::write(to, source)
}
