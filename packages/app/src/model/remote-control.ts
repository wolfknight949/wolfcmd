// N-06: whether an agent WolfCmd starts gets its own Remote Control (Claude Code: claude.ai/code
// and the Claude app), and the session's name there. Pure: the settings and the panel's
// workspace come in. A folder's choice lives in the user's settings, never in the folder.
import { folderKey } from "./document";

/** The settings this decides from (`[agents]` in settings.toml). */
interface RemoteControlPrefs {
  /** Every workspace. */
  readonly remote_control: boolean;
  /** Per workspace folder (`folderKey`): `true` always, `false` never; missing: the setting. */
  readonly remote_control_folders: Readonly<Partial<Record<string, boolean>>>;
}

/** The longest session name (characters). */
export const MAX_SESSION_NAME = 60;
const FALLBACK_NAME = "WolfCmd";

/** Whether agents started in a workspace of `folder` (`null`: none) get Remote Control. */
export function remoteControlOn(prefs: RemoteControlPrefs, folder: string | null): boolean {
  const own = folder === null ? undefined : prefs.remote_control_folders[folderKey(folder)];
  return own ?? prefs.remote_control;
}

/**
 * The folders after the user flips `folder`'s choice: the opposite of what it does now, kept
 * only while it differs from the setting (the same as the setting: the entry goes).
 */
export function flipFolder(prefs: RemoteControlPrefs, folder: string): Record<string, boolean> {
  const key = folderKey(folder);
  const next = !remoteControlOn(prefs, folder);
  const others: Record<string, boolean> = {};
  for (const [known, choice] of Object.entries(prefs.remote_control_folders)) {
    if (known !== key && choice !== undefined) others[known] = choice;
  }
  return next === prefs.remote_control ? others : { ...others, [key]: next };
}

/**
 * The session's name: "<workspace> · <tab>" (one of them when they are the same or one is
 * empty), in characters every shell takes in a quoted argument (letters, digits, spaces,
 * `-_.·`), at most `MAX_SESSION_NAME`, "WolfCmd" when nothing is left.
 */
export function sessionName(workspace: string, tab: string): string {
  const clean = (text: string) =>
    text
      .replace(/[^\p{L}\p{N} ._·-]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  const owner = clean(workspace);
  const own = clean(tab);
  const joined = owner === "" || owner === own ? own : own === "" ? owner : `${owner} · ${own}`;
  const name = Array.from(joined).slice(0, MAX_SESSION_NAME).join("").trim();
  return name === "" ? FALLBACK_NAME : name;
}

/** The name to start an agent with Remote Control under, or `undefined` when it starts without. */
export function remoteControlName(
  prefs: RemoteControlPrefs,
  folder: string | null,
  workspaceName: string,
  tabName: string,
): string | undefined {
  return remoteControlOn(prefs, folder) ? sessionName(workspaceName, tabName) : undefined;
}
