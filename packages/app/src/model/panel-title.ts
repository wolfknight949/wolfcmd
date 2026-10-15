// N-03: what a terminal panel's header calls it, one rule for new and restored panels alike: the user's
// title; else the title the program in it set, unless that is only the shell naming itself (its
// executable, `cmd`, `pwsh`…, or the folder it stands in); else the agent it runs; else the name
// of its shell profile ("Command Prompt", "PowerShell"); else "Terminal".
import type { AgentRef } from "@wolfcmd/bindings";

/** Titles shells give themselves: their own program name, or a folder path. */
const SHELL_TITLE =
  /^(?:cmd|command prompt|powershell|windows powershell|pwsh|bash|sh|zsh|fish|nu|wsl|wslhost|openconsole|conhost|elvish|xonsh|mintty)$|^MINGW(?:32|64)?:|^[a-z]:[\\/]|^~|^\//i;

/** Whether `title` is only the shell naming itself (not a program's own title). */
export function isShellTitle(title: string): boolean {
  return SHELL_TITLE.test(title.trim());
}

export function panelTitle(
  panel: {
    readonly title?: string | null | undefined;
    readonly agent?: AgentRef | null | undefined;
  },
  live: string | undefined,
  profileName: string | undefined,
  agentName?: string,
): string {
  const own = panel.title?.trim();
  if (own) return own;
  const program = live?.trim();
  if (program && !isShellTitle(program)) return program;
  if (panel.agent != null) return agentName ?? panel.agent.agent;
  return profileName ?? "Terminal";
}
