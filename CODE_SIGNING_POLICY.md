# Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

## What is signed

Only the Windows installer of WolfCmd (`WolfCmd_<version>_x64-setup.exe`), built from this repository's public source code.

- Every signed binary is built by GitHub Actions ([`.github/workflows/release.yml`](.github/workflows/release.yml)) from a tagged commit of this repository. Nothing built on a personal machine is ever submitted for signing.
- The signed installer is attached to the matching [GitHub release](https://github.com/wolfknight949/wolfcmd/releases) with its SHA-256 in `SHA256SUMS`.
- Third-party binaries shipped with WolfCmd keep their original publisher's signature: `conpty.dll` and `OpenConsole.exe` are signed by Microsoft ([`resources/conpty/`](resources/conpty/)).

## Team roles

| Role | Who |
|---|---|
| Committers and reviewers | [wolfknight949](https://github.com/wolfknight949) |
| Approvers | [wolfknight949](https://github.com/wolfknight949) |

Every signing request must be approved by an approver in SignPath before it is signed. Accounts with these roles use multi-factor authentication on GitHub and SignPath.

## Privacy

WolfCmd does not transfer any information to other networked systems unless the user asks for it: it has no telemetry, analytics, crash reporting or update checks. See [PRIVACY.md](PRIVACY.md).
