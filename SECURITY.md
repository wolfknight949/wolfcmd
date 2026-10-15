# Security policy

## Reporting a vulnerability

Please report security problems **privately**, not in a public issue: open the repository's **Security** tab and choose **Report a vulnerability** (GitHub's private vulnerability reporting, [direct link](https://github.com/wolfknight949/wolfcmd/security/advisories/new)).

Include what you found, how to reproduce it, the WolfCmd version (Settings › About) and your Windows version. You'll get an answer as soon as possible; once a fix is released, the advisory is published with credit to you unless you prefer otherwise.

## Supported versions

Fixes go into the latest release. Update with `winget upgrade Wolfknight949.WolfCmd.Beta` (or `Wolfknight949.WolfCmd` for stable releases), or install the newest installer from [Releases](https://github.com/wolfknight949/wolfcmd/releases).

## Scope

WolfCmd runs shells and agent CLIs on your machine with your rights; that is its purpose. Of interest are ways around its own boundaries, for example: a web page, terminal output or a plugin making WolfCmd run something the user didn't ask for, a link or file opened without a user's click, data sent to the network without the user's action, or saved files written outside WolfCmd's data folder.
