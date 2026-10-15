# Microsoft ConPTY (vendored)

> Status: Current · Bundled so every user gets the same, newer console host, whatever their Windows build.

`conpty.dll` and `OpenConsole.exe` from Microsoft's official
[`Microsoft.Windows.Console.ConPTY`](https://www.nuget.org/packages/Microsoft.Windows.Console.ConPTY)
NuGet package (source: [microsoft/terminal](https://github.com/microsoft/terminal)).
Placed next to our binaries, `portable-pty` loads this `conpty.dll` instead of the one built into
Windows, and shells run in this newer console host (about 3× faster output).

| | |
|---|---|
| Version | see `VERSION` |
| License | MIT, © Microsoft Corporation |
| Integrity | `SHA256SUMS` (checked by `cargo test -p wcmd-pty`); both files are Authenticode-signed by Microsoft |

## How it is used
- `crates/wcmd-pty/build.rs` copies the files for the target architecture next to every
  binary and test executable it builds (`target/<profile>/` and `target/<profile>/deps/`).
- The installer ships them next to `WolfCmd.exe` (`bundle.resources` in `tauri.conf.json`).
- At startup the app logs which console host is active (`wcmd_pty::console_host()`).

## Updating
1. Download the new `.nupkg` from nuget.org, verify both files' signatures (`Get-AuthenticodeSignature`).
2. Copy `runtimes/win-<arch>/native/conpty.dll` and `build/native/runtimes/<arch>/OpenConsole.exe`
   into `<arch>/`, update `VERSION` and `SHA256SUMS` (`sha256sum */* > SHA256SUMS`).
3. Re-run the ConPTY tests (`cargo test -p wcmd-pty`) and `pnpm e2e`; ConPTY behavior changes between versions.
