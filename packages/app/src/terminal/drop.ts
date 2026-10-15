// N-02: files dropped on a terminal (from Explorer, Finder or a file manager) become paths typed
// at its prompt, quoted for the shell that reads them. Pure; the panel types the result (never
// with Enter) and `panels/file-drops.ts` does the hit testing. Unit-tested.

/** How a shell reads what is typed: PowerShell, Command Prompt, or a POSIX shell (bash…). */
export type Quoting = "powershell" | "cmd" | "posix" | "agent";

/** Which way a path has to be written for the program that reads it. */
export type PathStyle =
  | { readonly kind: "native" }
  | { readonly kind: "git-bash" }
  | { readonly kind: "wsl"; readonly distro: string };

/** What the shell of a terminal panel needs to receive paths. */
export interface DropTarget {
  readonly quoting: Quoting;
  readonly style: PathStyle;
}

/**
 * The target for the shell with profile ID `profileId` (the one `pty_open` really started:
 * `pwsh`, `windows-powershell`, `cmd`, `git-bash`, `wsl.<distro>`; docs/guides/shell-profiles.md).
 * Any other profile is a POSIX shell on macOS or Linux, which gets the paths as they are.
 * `agent`: an agent runs in the panel; it reads pasted text as prose and takes `"C:\a b"` or a
 * bare path, so only paths that need it are quoted (with double quotes), but they are still
 * written the way its shell sees the disk.
 */
export function dropTarget(profileId: string, agent: boolean): DropTarget {
  let quoting: Quoting = "posix";
  let style: PathStyle = { kind: "native" };
  if (profileId === "pwsh" || profileId === "windows-powershell") {
    quoting = "powershell";
  } else if (profileId === "cmd") {
    quoting = "cmd";
  } else if (profileId === "git-bash") {
    style = { kind: "git-bash" };
  } else if (profileId.startsWith("wsl.")) {
    style = { kind: "wsl", distro: profileId.slice("wsl.".length) };
  }
  return { quoting: agent ? "agent" : quoting, style };
}

/** A profile ID's spelling of a WSL distribution name (`Ubuntu 24.04` → `ubuntu-24.04`). */
function distroId(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}

/** A path with a control character (a newline…) can't be typed safely on one line. */
function hasControl(path: string): boolean {
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/**
 * `path` as the program behind `style` names it. Native: unchanged. Git Bash: `C:\a\b` →
 * `/c/a/b`, `\\server\share` → `//server/share`. WSL: `C:\a\b` → `/mnt/c/a/b`, and a file in
 * this distribution's own disk (`\\wsl$\Ubuntu\home\me`, `\\wsl.localhost\…`) → `/home/me`;
 * other UNC paths stay as they are.
 */
export function translatePath(path: string, style: PathStyle): string {
  if (style.kind === "native") return path;
  const drive = /^([a-zA-Z]):(?:[\\/](.*))?$/.exec(path);
  if (drive) {
    const letter = (drive[1] ?? "").toLowerCase();
    const rest = (drive[2] ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
    const root = style.kind === "git-bash" ? `/${letter}` : `/mnt/${letter}`;
    return rest === "" ? root : `${root}/${rest}`;
  }
  const unc = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)(?:[\\/]+(.*))?$/.exec(path);
  if (!unc) return path;
  if (style.kind === "wsl") {
    const host = (unc[1] ?? "").toLowerCase();
    const distro = unc[2] ?? "";
    if ((host === "wsl$" || host === "wsl.localhost") && distroId(distro) === style.distro) {
      const rest = (unc[3] ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
      return `/${rest}`;
    }
    return path;
  }
  return path.replace(/\\/g, "/");
}

/** Characters that need no quoting for an agent (letters and digits of any script, `_.-:\/+`). */
const BARE = /^[\p{L}\p{N}_.:\\/+-]+$/u;

/**
 * `path` (already translated) quoted for `quoting`, or `undefined` when it can't be typed
 * safely (a control character, or a `"` for Command Prompt, which Windows file names can't
 * have anyway).
 * - PowerShell: `'C:\a b'`, a `'` (also the typographic ones PowerShell treats as quotes) doubled.
 * - Command Prompt: `"C:\a b"`.
 * - POSIX shells: `'/c/a b'`, a `'` written `'\''`.
 * - Agents: bare when nothing in it needs quoting, else `"C:\a b"`.
 * Shells always get quotes, even for a plain path: a bare folder typed at a PowerShell prompt
 * would run (and cd), a quoted one is only text.
 */
export function quotePath(path: string, quoting: Quoting): string | undefined {
  if (path === "" || hasControl(path)) return undefined;
  switch (quoting) {
    case "powershell":
      return `'${path.replace(/['\u2018\u2019\u201a\u201b]/g, (quote) => quote + quote)}'`;
    case "cmd":
      return path.includes('"') ? undefined : `"${path}"`;
    case "posix":
      return `'${path.replace(/'/g, "'\\''")}'`;
    case "agent":
      if (BARE.test(path)) return path;
      return path.includes('"') ? `'${path.replace(/'/g, "'\\''")}'` : `"${path}"`;
  }
}

/**
 * The text to type for dropped `paths`: each translated and quoted for `target`, joined by
 * single spaces, with a trailing space so the user can go on typing or drop more. Paths that
 * can't be typed safely are left out. Empty when nothing is left. Never ends with a newline:
 * dropping never runs anything.
 */
export function dropText(paths: readonly string[], target: DropTarget): string {
  const words = paths.flatMap((path) => {
    const quoted = quotePath(translatePath(path, target.style), target.quoting);
    return quoted === undefined ? [] : [quoted];
  });
  return words.length === 0 ? "" : `${words.join(" ")} `;
}
