# Builds the current code and installs it as your daily WolfCmd (%LOCALAPPDATA%\WolfCmd, your own
# data in %APPDATA%\WolfCmd), started by install-local.cmd. Nothing is published or versioned.

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..\..')

# The installer can't replace a running app.
$installed = Get-Process -Name 'WolfCmd' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path -notlike '*\target\*' }
if ($installed) {
    Write-Host 'Close WolfCmd first, then run this again.'
    exit 1
}

pnpm build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$target = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path (Get-Location) 'target' }
$installer = Get-ChildItem -LiteralPath (Join-Path $target 'release\bundle\nsis') -Filter '*-setup.exe' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $installer) {
    Write-Host "No installer found in $target\release\bundle\nsis."
    exit 1
}

Write-Host "Installing $($installer.Name)"
$run = Start-Process -FilePath $installer.FullName -ArgumentList '/S' -Wait -PassThru
if ($run.ExitCode -ne 0) {
    Write-Host "The installer stopped with code $($run.ExitCode)."
    exit $run.ExitCode
}

$app = Join-Path $env:LOCALAPPDATA 'WolfCmd\WolfCmd.exe'
if (Test-Path $app) {
    Write-Host 'Installed. Starting WolfCmd.'
    Start-Process -FilePath $app
} else {
    Write-Host 'Installed.'
}
