# WolfCmd in watch mode (hot reload for the UI, the Rust core restarts on change), started by
# dev-local.cmd. Asks which data to use:
#   1  test data (%APPDATA%\WolfCmd-dev, the default): your real workspaces are never touched;
#   2  your workspaces and settings: the installed app's own folder (%APPDATA%\WolfCmd).
# -Mine / -Test choose without asking.
param([switch]$Mine, [switch]$Test)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..\..')

$real = Join-Path $env:APPDATA 'WolfCmd'
$useMine = $Mine.IsPresent
if (-not $Mine -and -not $Test) {
    Write-Host 'WolfCmd, watch mode (hot reload)'
    Write-Host '  1  Test data (default): your workspaces are not touched'
    Write-Host "  2  My workspaces and settings ($real)"
    $useMine = (Read-Host 'Choose 1 or 2 (Enter: 1)') -eq '2'
}

if ($useMine) {
    # Both apps would write the same files, and the installed one would take the window.
    $installed = Get-Process -Name 'WolfCmd' -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.Path -notlike '*\target\*' }
    if ($installed) {
        Write-Host 'Close the installed WolfCmd first: both would write the same workspaces.'
        exit 1
    }
    # A folder of the earlier format is set aside as WolfCmd.old on the first start (never deleted).
    if ((Test-Path (Join-Path $real 'state.db')) -and -not (Test-Path (Join-Path $real 'workspaces.json'))) {
        Write-Host "$real holds data in the earlier format. WolfCmd will set it aside as WolfCmd.old (nothing is deleted)."
        if ((Read-Host 'Continue? (y/N)') -ne 'y') { exit 0 }
    }
    $env:WOLFCMD_DATA_DIR = $real
    Write-Host "Using $real"
}

pnpm dev
exit $LASTEXITCODE
