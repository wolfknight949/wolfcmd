// N-07: the Settings dialog's About section: the version and the data folder, which the core
// opens in the file manager.
import { type AboutInfo, commands } from "@wolfcmd/bindings";

import { unwrap } from "./ipc";

export type { AboutInfo };

/** The version (and the commit of a build from a checkout) and the data folder. */
export function aboutApp(): Promise<AboutInfo> {
  return commands.appAbout();
}

/** Opens the data folder in the file manager. */
export async function openDataFolder(): Promise<void> {
  unwrap(await commands.appOpenDataFolder());
}
