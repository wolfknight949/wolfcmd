// N-03: watching every frame a resize paints, to prove that terminals never blink.
//
// Two witnesses:
// - `installProbe`, in the page: after each painted frame it checks every shown terminal. A WebGL
//   canvas whose size changed (or that was just created) and that nothing drew on before the
//   frame was painted shows an empty frame: that is a blink. A DOM-rendered terminal with no text
//   is one too, and so is a terminal that left the page (unmounted). It also counts the
//   terminal's own resizes (its screen's size) and every `pty_resize` / `pty_open` call.
// - `nativeFrames`, on the desktop: moves, sizes, maximizes or minimizes the window through
//   Win32 like a user, captures what the screen shows after each step and compares it with the
//   first capture (text gone: a blank; colors that weren't there: a white or black flash).
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

import type { Page } from "playwright-core";

import { APP_WINDOW, waitFor, type WindowRect } from "./harness";

/** One blank frame the probe saw. */
export interface Blank {
  readonly frame: number;
  readonly panel: string;
  readonly why: string;
}

export interface ProbeReport {
  /** Frames painted since the probe started (or was reset). */
  readonly frames: number;
  readonly blanks: readonly Blank[];
  /** Each panel's terminal resizes (its screen changed size), by panel ID. */
  readonly termResizes: Readonly<Record<string, number>>;
  /** `pty_resize` calls: the PTY resizes (the shell reflows at each). */
  readonly ptyResizes: number;
  /** `pty_open` calls: a terminal mounted again (attach and replay). */
  readonly ptyOpens: number;
  /** WebGL draw calls (output, resizes). */
  readonly draws: number;
  /** Milliseconds since the last WebGL draw. */
  readonly sinceDraw: number;
  /** The shown terminals that render with WebGL. */
  readonly webglPanels: readonly string[];
}

/**
 * Starts the probe in the page (once per page load; later calls only reset the counts).
 * `freezeMs` (evidence only, `WOLFCMD_E2E_FREEZE_BLANKS`): after a blank frame the page stops for
 * that long, so the blank stays on screen for the native captures.
 */
export async function installProbe(
  page: Page,
  freezeMs = Number(process.env.WOLFCMD_E2E_FREEZE_BLANKS ?? 0),
): Promise<void> {
  await page.evaluate((freezeMs: number) => {
    interface Probe {
      frames: number;
      blanks: { frame: number; panel: string; why: string }[];
      termResizes: Record<string, number>;
      ptyResizes: number;
      ptyOpens: number;
      draws: number;
      lastDraw: number;
      webglPanels: string[];
      reset: () => void;
    }
    const host = window as unknown as { __wcProbe?: Probe };
    if (host.__wcProbe !== undefined) {
      host.__wcProbe.reset();
      return;
    }
    const dirty = new WeakSet<HTMLCanvasElement>();
    const gl = new WeakSet<HTMLCanvasElement>();
    const probe: Probe = {
      frames: 0,
      blanks: [],
      termResizes: {},
      ptyResizes: 0,
      ptyOpens: 0,
      draws: 0,
      lastDraw: performance.now(),
      webglPanels: [],
      reset() {
        probe.frames = 0;
        probe.blanks = [];
        probe.termResizes = {};
        probe.ptyResizes = 0;
        probe.ptyOpens = 0;
        probe.draws = 0;
      },
    };
    host.__wcProbe = probe;

    // A canvas whose size changes is cleared; a new WebGL canvas starts empty.
    for (const name of ["width", "height"] as const) {
      const property = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, name) as
        | {
            readonly get?: (this: HTMLCanvasElement) => number;
            readonly set?: (this: HTMLCanvasElement, value: number) => void;
            readonly enumerable?: boolean;
          }
        | undefined;
      const get = property?.get;
      const set = property?.set;
      if (get === undefined || set === undefined) continue;
      Object.defineProperty(HTMLCanvasElement.prototype, name, {
        configurable: true,
        enumerable: property?.enumerable ?? true,
        get,
        set(this: HTMLCanvasElement, value: number) {
          if (get.call(this) !== value) dirty.add(this);
          set.call(this, value);
        },
      });
    }
    type GetContext = (this: HTMLCanvasElement, ...args: unknown[]) => unknown;
    const canvasProto = HTMLCanvasElement.prototype as unknown as { getContext: GetContext };
    const getContext = canvasProto.getContext;
    canvasProto.getContext = function (this: HTMLCanvasElement, ...args: unknown[]) {
      const kind = args[0];
      const known = gl.has(this);
      const context = getContext.apply(this, args);
      if ((kind === "webgl2" || kind === "webgl") && context !== null && !known) {
        gl.add(this);
        dirty.add(this);
      }
      return context;
    };
    // Drawing paints the canvas (xterm draws its cells, backgrounds included, as instances).
    for (const name of [
      "drawArrays",
      "drawElements",
      "drawArraysInstanced",
      "drawElementsInstanced",
    ] as const) {
      type Draw = (this: WebGL2RenderingContext, ...args: unknown[]) => void;
      const glProto = WebGL2RenderingContext.prototype as unknown as Record<string, Draw>;
      const original = glProto[name];
      if (original === undefined) continue;
      glProto[name] = function (this: WebGL2RenderingContext, ...args: unknown[]) {
        original.apply(this, args);
        if (this.canvas instanceof HTMLCanvasElement) dirty.delete(this.canvas);
        probe.draws += 1;
        probe.lastDraw = performance.now();
      };
    }

    // Tauri's invoke can't be replaced, but each command is a fetch of http://ipc.localhost/<cmd>.
    const fetchIpc = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("ipc.localhost/pty_resize")) probe.ptyResizes += 1;
      if (url.includes("ipc.localhost/pty_open")) probe.ptyOpens += 1;
      return fetchIpc(input, init);
    };

    // After each painted frame: what did every shown terminal show?
    const seen = new Set<string>();
    const sizes = new Map<string, string>();
    const check = (frame: number) => {
      const present = new Set<string>();
      const webgl: string[] = [];
      for (const card of document.querySelectorAll<HTMLElement>("[data-panel]")) {
        const id = card.dataset.panel ?? "";
        present.add(id);
        if (card.classList.contains("invisible") || card.getBoundingClientRect().right <= 0) {
          continue;
        }
        const screen = card.querySelector<HTMLElement>(".xterm-screen");
        let why: string | undefined;
        if (screen === null) {
          why = "no terminal";
        } else {
          const size = `${screen.style.width}x${screen.style.height}`;
          const before = sizes.get(id);
          if (before !== undefined && before !== size) {
            probe.termResizes[id] = (probe.termResizes[id] ?? 0) + 1;
          }
          sizes.set(id, size);
          const canvas = [...screen.querySelectorAll("canvas")].find((c) => gl.has(c));
          if (canvas !== undefined) {
            webgl.push(id);
            if (dirty.has(canvas)) why = "WebGL canvas cleared, not drawn yet";
          } else if ((screen.querySelector(".xterm-rows")?.textContent ?? "").trim() === "") {
            why = "no text";
          }
        }
        if (why === undefined) seen.add(id);
        else if (seen.has(id)) {
          probe.blanks.push({ frame, panel: id, why });
          // Evidence only: hold the blank frame on screen so a screen capture can show it.
          for (const until = performance.now() + freezeMs; performance.now() < until;);
        }
      }
      for (const id of seen) {
        if (!present.has(id)) {
          probe.blanks.push({ frame, panel: id, why: "unmounted" });
          seen.delete(id);
        }
      }
      probe.webglPanels = webgl;
    };
    // A message posted from a frame callback arrives once that frame has been painted.
    const channel = new MessageChannel();
    channel.port1.onmessage = (event: MessageEvent<number>) => {
      check(event.data);
    };
    const tick = () => {
      probe.frames += 1;
      channel.port2.postMessage(probe.frames);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, freezeMs);
}

export async function probeReport(page: Page): Promise<ProbeReport> {
  return page.evaluate(() => {
    const probe = (window as unknown as { __wcProbe: ProbeReport & { lastDraw: number } })
      .__wcProbe;
    return {
      frames: probe.frames,
      blanks: probe.blanks,
      termResizes: probe.termResizes,
      ptyResizes: probe.ptyResizes,
      ptyOpens: probe.ptyOpens,
      draws: probe.draws,
      sinceDraw: performance.now() - probe.lastDraw,
      webglPanels: probe.webglPanels,
    };
  });
}

export async function resetProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __wcProbe: { reset: () => void } }).__wcProbe.reset();
  });
}

/**
 * Waits until the terminals have drawn and then stayed still for `quietMs`: a WebGL screen can't
 * be read, so this is how a scenario knows that output has been painted (shorter than the
 * cursor's 600 ms blink, which draws too).
 */
export async function waitForQuiet(page: Page, quietMs = 300, timeout = 30_000): Promise<void> {
  await waitFor(
    "the terminals to finish drawing",
    async () => {
      const report = await probeReport(page);
      return report.sinceDraw > quietMs;
    },
    timeout,
  );
}

/** Waits until the probe has counted `frames` more painted frames. */
export async function waitFrames(page: Page, frames: number): Promise<void> {
  const start = (await probeReport(page)).frames;
  await waitFor("painted frames", async () => (await probeReport(page)).frames >= start + frames);
}

// ---- Native frames: what the screen shows, step by step ----

/** One step: place the window, or minimize / maximize / restore it, then wait `wait` ms. */
export type WindowStep =
  | { readonly rect: WindowRect; readonly wait: number }
  | { readonly show: "minimize" | "maximize" | "restore"; readonly wait: number };

export interface NativeFrame {
  /** Its step (0: the reference capture before the first step). */
  readonly step: number;
  /** Share of pixels that are text (far from the background). */
  readonly ink: number;
  /** Share of pixels in colors the reference didn't have (a white or black flash). */
  readonly foreign: number;
  readonly width: number;
  readonly height: number;
}

export interface NativeRun {
  readonly reference: NativeFrame;
  readonly frames: readonly NativeFrame[];
  /** How long the steps took (ms), so a scenario can tell its pace. */
  readonly elapsed: number;
}

const NATIVE = String.raw`
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
public static class WcFrames {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int hh, uint f);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int size);

  static Bitmap Capture(IntPtr h) {
    RECT r;
    DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT)));
    int w = r.R - r.L, hh = r.B - r.T;
    if (w <= 0 || hh <= 0) return null;
    var b = new Bitmap(w, hh, PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(b)) g.CopyFromScreen(r.L, r.T, 0, 0, new Size(w, hh));
    return b;
  }
  static int[] Pixels(Bitmap b) {
    var d = b.LockBits(new Rectangle(0, 0, b.Width, b.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    var p = new int[b.Width * b.Height];
    Marshal.Copy(d.Scan0, p, 0, p.Length);
    b.UnlockBits(d);
    return p;
  }
  static int Bin(int c) { return ((c >> 20) & 0xF) << 8 | ((c >> 12) & 0xF) << 4 | ((c >> 4) & 0xF); }
  static int Lum(int c) { return (((c >> 16) & 0xFF) * 3 + ((c >> 8) & 0xFF) * 6 + (c & 0xFF)) / 10; }

  public static string Run(IntPtr h, string steps, string outDir, int every) {
    SetThreadDpiAwarenessContext((IntPtr)(-4));
    SetForegroundWindow(h);
    // On top while it is watched, so the captures show only WolfCmd.
    SetWindowPos(h, (IntPtr)(-1), 0, 0, 0, 0, 0x13);
    Thread.Sleep(150);
    var frames = new List<Bitmap>();
    var names = new List<int>();
    frames.Add(Capture(h)); names.Add(0);
    int i = 0;
    var clock = System.Diagnostics.Stopwatch.StartNew();
    foreach (var step in steps.Split(';')) {
      i++;
      var f = step.Split(',');
      if (f[0] == "min") ShowWindow(h, 6);
      else if (f[0] == "max") ShowWindow(h, 3);
      else if (f[0] == "restore") ShowWindow(h, 9);
      else SetWindowPos(h, IntPtr.Zero, int.Parse(f[0]), int.Parse(f[1]), int.Parse(f[2]), int.Parse(f[3]), 0x14);
      Thread.Sleep(int.Parse(f[f.Length - 1]));
      if (IsIconic(h) || (i % every != 0 && int.Parse(f[f.Length - 1]) < 100)) continue;
      var b = Capture(h);
      if (b != null) { frames.Add(b); names.Add(i); }
    }
    long elapsed = clock.ElapsedMilliseconds;
    SetWindowPos(h, (IntPtr)(-2), 0, 0, 0, 0, 0x13);
    // The reference: its background (the most common color) and the colors it has.
    var refPixels = Pixels(frames[0]);
    var counts = new Dictionary<int, int>();
    foreach (var c in refPixels) { int k = Bin(c); int n; counts.TryGetValue(k, out n); counts[k] = n + 1; }
    int bg = 0, most = -1;
    foreach (var kv in counts) if (kv.Value > most) { most = kv.Value; bg = kv.Key; }
    var known = new HashSet<int>();
    foreach (var kv in counts) if (kv.Value * 200 >= refPixels.Length) known.Add(kv.Key);
    int bgLum = ((bg >> 8) * 17 * 3 + ((bg >> 4) & 0xF) * 17 * 6 + (bg & 0xF) * 17) / 10;
    var lines = new List<string>();
    for (int j = 0; j < frames.Count; j++) {
      var p = j == 0 ? refPixels : Pixels(frames[j]);
      long ink = 0, foreign = 0;
      foreach (var c in p) {
        if (Math.Abs(Lum(c) - bgLum) > 60) ink++;
        else if (!known.Contains(Bin(c))) foreign++;
      }
      lines.Add(string.Format(CultureInfo.InvariantCulture, "{0},{1:F5},{2:F5},{3},{4}",
        names[j], (double)ink / p.Length, (double)foreign / p.Length, frames[j].Width, frames[j].Height));
    }
    if (outDir.Length > 0) {
      // A contact sheet: every capture at a quarter of its size, in order.
      int cols = 6, tw = frames[0].Width / 4, th = frames[0].Height / 4;
      int rows = (frames.Count + cols - 1) / cols;
      using (var sheet = new Bitmap(cols * (tw + 4), rows * (th + 4)))
      using (var g = Graphics.FromImage(sheet)) {
        g.Clear(Color.Gray);
        for (int j = 0; j < frames.Count; j++) {
          var fr = frames[j];
          double s = Math.Min((double)tw / fr.Width, (double)th / fr.Height);
          g.DrawImage(fr, (j % cols) * (tw + 4), (j / cols) * (th + 4), (int)(fr.Width * s), (int)(fr.Height * s));
        }
        sheet.Save(Path.Combine(outDir, "sheet.png"), ImageFormat.Png);
      }
      for (int j = 0; j < frames.Count; j++) frames[j].Save(Path.Combine(outDir, string.Format("frame-{0:D3}.png", names[j])), ImageFormat.Png);
    }
    foreach (var b in frames) b.Dispose();
    return "elapsed," + elapsed + "\n" + string.Join("\n", lines);
  }
}
"@
${APP_WINDOW}
if ($h -eq [IntPtr]::Zero) { throw "no window" }
[WcFrames]::Run($h, $env:WC_STEPS, $env:WC_OUT, [int]$env:WC_EVERY)
`;

/**
 * Runs the steps against the window (one PowerShell, so the steps come as fast as a drag) and
 * captures the screen after every `every`th step and after each settling one (a capture takes
 * longer than a frame). `outDir`: also saves the captures and a contact sheet there.
 */
export function nativeFrames(
  pid: number,
  steps: readonly WindowStep[],
  { outDir = "", every = 1 }: { readonly outDir?: string; readonly every?: number } = {},
): NativeRun {
  if (outDir !== "") mkdirSync(outDir, { recursive: true });
  const spec = steps
    .map((step) =>
      "rect" in step
        ? [step.rect.x, step.rect.y, step.rect.width, step.rect.height, step.wait].join(",")
        : `${{ minimize: "min", maximize: "max", restore: "restore" }[step.show]},${String(step.wait)}`,
    )
    .join(";");
  const out = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", NATIVE],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        WC_PID: String(pid),
        WC_STEPS: spec,
        WC_OUT: outDir,
        WC_EVERY: String(every),
      },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const [timing = "", ...lines] = out.trim().split(/\r?\n/);
  const frames = lines.map((line) => {
    const [step = 0, ink = 0, foreign = 0, width = 0, height = 0] = line.split(",").map(Number);
    return { step, ink, foreign, width, height };
  });
  const [reference, ...rest] = frames;
  if (reference === undefined || !timing.startsWith("elapsed,")) {
    throw new Error(`no captures:\n${out}`);
  }
  return { reference, frames: rest, elapsed: Number(timing.split(",")[1]) };
}

/** The captures that lost the text (a blank) or showed colors the window never has (a flash). */
export function badFrames(run: NativeRun): { blank: NativeFrame[]; flash: NativeFrame[] } {
  return {
    blank: run.frames.filter((frame) => frame.ink < run.reference.ink * 0.35),
    flash: run.frames.filter((frame) => frame.foreign > 0.2),
  };
}

/** Sizes in between `from` and `to` (both included), like a drag. */
export function dragRects(from: WindowRect, to: WindowRect, steps: number): WindowRect[] {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps;
    const at = (a: number, b: number) => Math.round(a + (b - a) * t);
    return {
      x: at(from.x, to.x),
      y: at(from.y, to.y),
      width: at(from.width, to.width),
      height: at(from.height, to.height),
    };
  });
}
