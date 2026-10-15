// The end-to-end harness: starts the real WolfCmd.exe on a fresh data folder, connects to its
// WebView2 page over the Chrome DevTools Protocol (playwright-core, no browser download) and
// cleans everything up, even when a test fails. Windows only.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type Browser, chromium, type Page } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
/** One screenshot per scenario (git-ignored). */
const SCREENSHOTS = resolve(here, "../screenshots");

/** The debug app `pnpm e2e` builds (`WOLFCMD_E2E_EXE` points at another one). */
function appExe(): string {
  const chosen = process.env.WOLFCMD_E2E_EXE;
  if (chosen !== undefined && chosen !== "") return chosen;
  const target = process.env.CARGO_TARGET_DIR ?? join(repoRoot, "target");
  return join(target, "debug", "WolfCmd.exe");
}

export const sleep = (ms: number) =>
  new Promise<void>((done) => {
    setTimeout(done, ms);
  });

/** Polls `check` until it returns something other than `undefined` or `false`. */
export async function waitFor<T>(
  what: string,
  check: () => T | undefined | false | Promise<T | undefined | false>,
  timeout = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: unknown;
  for (;;) {
    try {
      const value = await check();
      if (value !== undefined && value !== false) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`, { cause: last });
    }
    await sleep(100);
  }
}

/** Every process tree this run started, killed on exit whatever happens. */
const live = new Set<number>();
function killTree(pid: number) {
  try {
    execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
  } catch {
    // Already gone.
  }
  live.delete(pid);
}
process.once("exit", () => {
  for (const pid of live) killTree(pid);
});

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => {
        done(port);
      });
    });
  });
}

/**
 * Not passed on to WolfCmd: PATH is set below, and Command Prompt must look in the current
 * folder first (agent stand-ins; Claude Code turns that off for the shells it runs).
 */
const DROPPED_ENV = new Set(["PATH", "NODEFAULTCURRENTDIRECTORYINEXEPATH"]);

/** Ends every process whose command line names `folder` (WebView2 stragglers, shells). */
function killUnder(folder: string) {
  const script =
    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and " +
    "$_.CommandLine.Contains($env:WC_ROOT) } | ForEach-Object { " +
    "Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      stdio: "ignore",
      env: { ...process.env, WC_ROOT: folder },
    });
  } catch {
    // Nothing to end.
  }
}

/**
 * A fresh WolfCmd home for one test: its data folder (`WOLFCMD_DATA_DIR`), its own WebView2
 * profile, and a `bin` folder first on PATH (stub agents). Removed by `dispose`.
 */
export class Sandbox {
  readonly root: string;
  readonly dataDir: string;
  readonly binDir: string;
  private readonly webviewDir: string;
  private app: RunningApp | undefined;

  constructor(name: string) {
    this.root = mkdtempSync(join(tmpdir(), `wcmd-e2e-${name}-`));
    this.dataDir = join(this.root, "data");
    this.binDir = join(this.root, "bin");
    this.webviewDir = join(this.root, "webview");
    for (const dir of [this.dataDir, this.binDir, this.webviewDir]) mkdirSync(dir);
  }

  /** A folder inside the sandbox (created). */
  folder(name: string): string {
    const dir = join(this.root, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  dataFile(name: string): string {
    return join(this.dataDir, name);
  }

  /** The saved `workspaces.json`, parsed. */
  savedDocument(): SavedDocument {
    return JSON.parse(readFileSync(this.dataFile("workspaces.json"), "utf8")) as SavedDocument;
  }

  /**
   * Starts WolfCmd.exe and connects to its page. One app per sandbox at a time. `webgl` keeps
   * xterm's WebGL renderer, what users run (the N-03 blink scenarios); `screen()` can't read it.
   * `env` adds to the app's environment (its shells inherit it: the showcase's `PROMPT`).
   */
  async launch({
    webgl = false,
    env = {},
  }: {
    readonly webgl?: boolean;
    readonly env?: Readonly<Record<string, string>>;
  } = {}): Promise<RunningApp> {
    if (this.app !== undefined && !this.app.exited) throw new Error("the app is still running");
    const exe = appExe();
    if (!existsSync(exe)) throw new Error(`${exe} is missing: run \`pnpm e2e\` (it builds it)`);
    const port = await freePort();
    // N-02: the window the user works in gets the foreground back once the app's window took it.
    const giveBack = await foregroundKeeper();
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !DROPPED_ENV.has(name.toUpperCase())),
    );
    // The app's log (`tracing` on stderr), kept with a failed scenario's screenshot.
    const log = openSync(this.logFile, "a");
    const child = spawn(exe, [], {
      cwd: this.root,
      stdio: ["ignore", log, log],
      env: {
        ...inherited,
        ...env,
        // The stand-in agents come first. Windows spells it "Path": one entry, or the child
        // may see the original.
        Path: `${this.binDir};${process.env.PATH ?? ""}`,
        WOLFCMD_DATA_DIR: this.dataDir,
        // Command Prompt: a shell the tests control (no user profile scripts).
        WOLFCMD_DEFAULT_PROFILE: "cmd",
        WEBVIEW2_USER_DATA_FOLDER: this.webviewDir,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: [
          `--remote-debugging-port=${String(port)}`,
          // xterm's DOM renderer, so the tests can read the screen (WebGL draws on a canvas).
          ...(webgl ? [] : ["--disable-webgl", "--disable-webgl2"]),
          // Keep painting while the window is behind others.
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
          "--disable-features=CalculateNativeWinOcclusion,msWebOOUI,msPdfOOUI,msSmartScreenProtection",
        ].join(" "),
      },
    });
    closeSync(log);
    const pid = child.pid;
    if (pid === undefined) throw new Error(`could not start ${exe}`);
    live.add(pid);
    const app = new RunningApp(child, pid);
    this.app = app;
    giveBack?.(pid, (what) => {
      app.note(what);
    });
    try {
      await app.connect(port);
    } catch (error) {
      await app.kill();
      throw error;
    }
    return app;
  }

  /** The app launched last (it may have exited). */
  get current(): RunningApp | undefined {
    return this.app;
  }

  private get logFile(): string {
    return join(this.root, "app.log");
  }

  /**
   * Ends a scenario (`afterEach`): when it failed, keeps the evidence under
   * tests/e2e/screenshots/: `FAILED-<name>.png` (the page, if it is still there) and
   * `FAILED-<name>.log` (what happened to the process and its page, then the app's own log), so
   * a page that went away says whether the app crashed, reloaded or exited. Then `dispose`.
   */
  async finish(task: {
    readonly name: string;
    readonly result?: { readonly state?: string };
  }): Promise<void> {
    if (task.result?.state === "fail") {
      const name = `FAILED-${task.name.slice(0, 40).replace(/\W+/g, "-")}`;
      const app = this.app;
      if (app !== undefined && !app.exited) await app.screenshot(name).catch(() => undefined);
      mkdirSync(SCREENSHOTS, { recursive: true });
      const log = existsSync(this.logFile) ? readFileSync(this.logFile, "utf8") : "(no log)";
      writeFileSync(
        join(SCREENSHOTS, `${name}.log`),
        [...(app?.events ?? []), "---- app log ----", log].join("\n"),
      );
    }
    await this.dispose();
  }

  /** Kills whatever still runs and removes the folder. */
  async dispose(): Promise<void> {
    if (this.app !== undefined) await this.app.kill();
    // WebView2 lets go of its profile a moment after its processes end.
    for (let attempt = 0; ; attempt++) {
      try {
        rmSync(this.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        return;
      } catch (error) {
        if (attempt >= 3) throw error;
        killUnder(this.root);
        await sleep(1_000);
      }
    }
  }
}

/** N-03: a panel of format 2: its content says its kind; a terminal's has its fields. */
export interface SavedPanel {
  id: string;
  title?: string | null;
  content: {
    kind: string;
    profile?: string | null;
    cwd?: string | null;
    agent?: { agent: string; session?: string | null; running?: boolean } | null;
  };
}
export type SavedLayout =
  | ({ kind: "panel" } & SavedPanel)
  | { kind: "split"; direction: string; children: SavedLayout[]; ratios: number[] };
export interface SavedTab {
  id: string;
  name: string;
  layout: SavedLayout | null;
  focused: string | null;
  /** N-03: the panel that fills the tab. */
  maximized?: string | null;
}
export interface SavedWorkspace {
  id: string;
  name: string;
  folder: string | null;
  tabs: SavedTab[];
  activeTab: string | null;
}
export interface SavedDocument {
  version: number;
  workspaces: SavedWorkspace[];
  active: string | null;
}

/** Every panel of a saved layout, in order. */
export function savedPanels(layout: SavedLayout | null): SavedPanel[] {
  if (layout === null) return [];
  return layout.kind === "panel" ? [layout] : layout.children.flatMap(savedPanels);
}

/** One running WolfCmd.exe and its page. */
export class RunningApp {
  page!: Page;
  private browser: Browser | undefined;
  private readonly ended: Promise<void>;
  private readonly started = Date.now();
  exited = false;
  /** What happened to the process, its browser and its page, timed from the launch. */
  readonly events: string[] = [];

  constructor(
    child: ChildProcess,
    readonly pid: number,
  ) {
    this.ended = new Promise((done) => {
      child.once("exit", (code, signal) => {
        this.note(`WolfCmd.exe exited (code ${String(code)}, signal ${String(signal)})`);
        this.exited = true;
        live.delete(pid);
        done();
      });
    });
  }

  async connect(port: number): Promise<void> {
    const endpoint = `http://127.0.0.1:${String(port)}`;
    await waitFor(
      "the DevTools endpoint",
      async () => {
        if (this.exited) throw new Error("WolfCmd.exe exited");
        const answer = await fetch(`${endpoint}/json/version`);
        return answer.ok;
      },
      30_000,
    );
    this.browser = await chromium.connectOverCDP(endpoint);
    this.browser.on("disconnected", () => {
      this.note("the DevTools connection closed");
    });
    const context = this.browser.contexts()[0];
    if (context === undefined) throw new Error("no browser context");
    this.page = await waitFor("the app page", () =>
      context.pages().find((page) => page.url().startsWith("http://tauri.localhost")),
    );
    const page = this.page;
    page.on("crash", () => {
      this.note("the page crashed");
    });
    page.on("close", () => {
      this.note("the page closed");
    });
    page.on("pageerror", (error) => {
      this.note(`page error: ${error.message}`);
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) this.note(`the page loaded ${frame.url()}`);
    });
    // Focus and keyboard work while the window is behind other windows.
    const cdp = await context.newCDPSession(this.page);
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await this.page.locator("header [role=tablist], header button").first().waitFor();
  }

  /** Notes what happened, timed from the launch (kept in a failed scenario's log). */
  note(what: string) {
    this.events.push(`+${String(Date.now() - this.started)} ms: ${what}`);
  }

  /** `taskkill /F /T`: no chance to save anything, like a crash or a power cut. */
  async kill(): Promise<void> {
    if (!this.exited) {
      this.note("killed by the test");
      killTree(this.pid);
    }
    await this.ended;
    await this.disconnect();
  }

  /**
   * The window's Close button; waits for the process to end. N-01: only with
   * `window.close_to_tray` off in the sandbox's settings (else Close hides to the tray: `hide`).
   */
  async closeWindow(): Promise<void> {
    await this.page.locator('header button[aria-label="Close"]').click();
    await this.exit("Close");
  }

  /** N-01: the window's Close button with the default settings: the window hides to the tray. */
  async hide(): Promise<void> {
    await this.page.locator('header button[aria-label="Close"]').click();
  }

  /**
   * N-01: Ctrl+Q, the real quit (like the tray's Quit); waits for the process to end. N-11:
   * with an agent running WolfCmd asks first: the answer is Quit.
   */
  async quit(): Promise<void> {
    await this.page.keyboard.press("Control+q");
    const confirm = this.page
      .getByRole("dialog", { name: "Quit WolfCmd?" })
      .getByRole("button", { name: "Quit", exact: true });
    await Promise.race([this.ended, confirm.click({ timeout: 15_000 }).catch(() => undefined)]);
    await this.exit("Ctrl+Q");
  }

  private async exit(what: string): Promise<void> {
    await Promise.race([
      this.ended,
      sleep(15_000).then(() => {
        throw new Error(`WolfCmd.exe did not exit after ${what}`);
      }),
    ]);
    await this.disconnect();
  }

  private async disconnect() {
    const browser = this.browser;
    this.browser = undefined;
    await browser?.close().catch(() => undefined);
  }

  /** Saves a screenshot of the window's page; returns its path. */
  async screenshot(name: string): Promise<string> {
    mkdirSync(SCREENSHOTS, { recursive: true });
    const path = join(SCREENSHOTS, `${name}.png`);
    await this.page.screenshot({ path });
    return path;
  }
}

// ---- The window, through Win32 (PowerShell; nothing to install) ----

/**
 * N-02: each app's window takes the foreground when it opens, so keys someone types meanwhile
 * (in an editor, a chat, another terminal) would land in the scenario's terminal: a stray letter,
 * a Backspace eating one of the test's, an Enter on a button. The scenarios don't need the
 * foreground (focus is emulated over DevTools), so the window that had it gets it back.
 */
const FOREGROUND = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class WcFront {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
"@
$before = [WcFront]::GetForegroundWindow()
"ready"
$appPid = [uint32][Console]::In.ReadLine()
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
  $front = [WcFront]::GetForegroundWindow()
  $owner = [uint32]0
  $thread = [WcFront]::GetWindowThreadProcessId($front, [ref]$owner)
  if ($owner -eq $appPid) {
    if ($before -eq [IntPtr]::Zero -or -not [WcFront]::IsWindow($before)) { "nothing to give back"; exit }
    $me = [WcFront]::GetCurrentThreadId()
    [void][WcFront]::AttachThreadInput($me, $thread, $true)
    $done = [WcFront]::SetForegroundWindow($before)
    [void][WcFront]::AttachThreadInput($me, $thread, $false)
    if ($done) { "given back" } else { "not given back" }
    exit
  }
  Start-Sleep -Milliseconds 25
}
"never in front"
`;

/**
 * Notes the foreground window now; the returned function, given the app's process, hands the
 * foreground back to it once that app's window took it. Undefined when PowerShell can't help.
 */
async function foregroundKeeper(): Promise<
  ((pid: number, note: (what: string) => void) => void) | undefined
> {
  const shell = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", FOREGROUND], {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  const lines: string[] = [];
  const state = { ended: false };
  shell.stdout.setEncoding("utf8");
  shell.stdout.on("data", (chunk: string) => {
    lines.push(...chunk.split(/\r?\n/).filter((line) => line.trim() !== ""));
  });
  shell.once("exit", () => {
    state.ended = true;
  });
  try {
    await waitFor("the foreground helper", () => state.ended || lines.includes("ready"), 20_000);
  } catch {
    shell.kill();
    return undefined;
  }
  if (state.ended) return undefined;
  return (pid, note) => {
    shell.once("exit", () => {
      note(`foreground: ${lines.filter((line) => line !== "ready").join(", ") || "(none)"}`);
    });
    shell.stdin.end(`${String(pid)}\n`);
  };
}

export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** N-01: finds the app's own window into `$h` (a titled top-level window of the process, never the
 * event loop's sizeless helper window, which Windows may name as the main window once the real one
 * is hidden to the tray). */
export const APP_WINDOW = `
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class WcE2E {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int hh, uint f);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  // The app's window: a titled top-level window of the process, not the event loop's helper.
  public static IntPtr AppWindow(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint owner; GetWindowThreadProcessId(h, out owner);
      if (owner != pid) return true;
      var title = new StringBuilder(256); GetWindowText(h, title, 256);
      var cls = new StringBuilder(256); GetClassName(h, cls, 256);
      if (title.Length == 0 || cls.ToString() == "Tao Thread Event Target") return true;
      found = h; return false;
    }, IntPtr.Zero);
    return found;
  }
}
"@
$h = [WcE2E]::AppWindow([uint32]$env:WC_PID)
`;

const WIN32 = `${APP_WINDOW}
# Physical pixels, like the app (a DPI-unaware caller would see scaled ones).
[void][WcE2E]::SetThreadDpiAwarenessContext([IntPtr]-4)
if ($h -eq [IntPtr]::Zero) { throw "no window" }
if ($env:WC_MOVE) {
  $m = $env:WC_MOVE.Split(",")
  [void][WcE2E]::SetWindowPos($h, [IntPtr]::Zero, [int]$m[0], [int]$m[1], [int]$m[2], [int]$m[3], 0x14)
}
$r = New-Object WcE2E+RECT
[void][WcE2E]::GetWindowRect($h, [ref]$r)
"{0},{1},{2},{3}" -f $r.L, $r.T, ($r.R - $r.L), ($r.B - $r.T)
`;

function win32(pid: number, move?: WindowRect): WindowRect {
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WIN32], {
    encoding: "utf8",
    env: {
      ...process.env,
      WC_PID: String(pid),
      WC_MOVE: move
        ? `${String(move.x)},${String(move.y)},${String(move.width)},${String(move.height)}`
        : "",
    },
  });
  const [x = NaN, y = NaN, width = NaN, height = NaN] = out.trim().split(",").map(Number);
  return { x, y, width, height };
}

/** The window's outer rectangle (physical pixels). */
export const windowRect = (pid: number) => win32(pid);
/** Moves and sizes the window like a user dragging it (outer rectangle, physical pixels). */
export const placeWindow = (pid: number, rect: WindowRect) => win32(pid, rect);

/**
 * N-01: whether the app's window is on screen (hidden to the tray: not). Finds the titled window,
 * never the event loop's sizeless helper window, which Windows may name as the main window.
 */
export function windowShown(pid: number): boolean {
  const out = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `${APP_WINDOW}
($h -ne [IntPtr]::Zero) -and [WcE2E]::IsWindowVisible($h)`,
    ],
    { encoding: "utf8", env: { ...process.env, WC_PID: String(pid) } },
  );
  return out.trim() === "True";
}

/** Writes a file (UTF-8), creating its folder. */
export function writeText(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
