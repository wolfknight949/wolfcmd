// N-06: a stand-in for Claude Code, never the real agent. `claude.cmd` runs a PowerShell script
// that, for each line typed, sets Claude Code's working title (◐ / ◑) and prints for 4 s, then
// sets its idle title (✳) and waits again.
import { join } from "node:path";

import { writeText } from "./harness";

const STUB_CMD =
  '@echo off\r\necho stub-claude %*\r\nif "%~1"=="--version" exit /b 0\r\n' +
  'powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0stub-agent.ps1"\r\n';

// Titles through the console API: ConPTY sends them on as OSC 0, as with the real agent.
const STUB_PS1 = [
  "$working = @([char]0x25D0, [char]0x25D1)",
  "$idle = [char]0x2733",
  '$Host.UI.RawUI.WindowTitle = "$idle Claude Code"',
  "while ($true) {",
  "  $line = [Console]::ReadLine()",
  "  if ($null -eq $line) { break }",
  "  for ($i = 0; $i -lt 20; $i++) {",
  '    $Host.UI.RawUI.WindowTitle = "$($working[$i % 2]) $line"',
  '    [Console]::WriteLine("working on $line $i")',
  "    Start-Sleep -Milliseconds 200",
  "  }",
  '  $Host.UI.RawUI.WindowTitle = "$idle $line"',
  '  [Console]::WriteLine("done $line")',
  "}",
].join("\r\n");

/**
 * Puts the stand-in in each folder (Command Prompt looks in its current folder first, so an
 * agent panel started there runs it).
 */
export function installStubAgent(...dirs: readonly string[]): void {
  for (const dir of dirs) {
    writeText(join(dir, "claude.cmd"), STUB_CMD);
    writeText(join(dir, "stub-agent.ps1"), STUB_PS1);
  }
}
