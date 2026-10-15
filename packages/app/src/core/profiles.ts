// N-03: the shell profiles this computer has (PowerShell, Command Prompt, Git Bash, WSL…).
import { commands, type ProfileInfo } from "@wolfcmd/bindings";

import { unwrap } from "./ipc";

/** The profiles, the default one marked. Read once at start. */
export async function listProfiles(): Promise<ProfileInfo[]> {
  return unwrap(await commands.ptyListProfiles());
}
