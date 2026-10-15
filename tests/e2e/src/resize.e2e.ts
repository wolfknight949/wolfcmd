// N-03: resizing never makes a terminal blink. With xterm's WebGL renderer (what users run),
// every painted frame is checked (`frames.ts`): a terminal never shows an empty frame, never
// leaves the page, and the shells reflow once a resize settles, not at every step. The window is
// driven through Win32 like a user; the captures of the screen must keep the text and never
// flash a color the window doesn't have. Each scenario saves its captures and a contact sheet
// under tests/e2e/screenshots/frames-<name>/ (`WOLFCMD_E2E_FRAMES` puts them elsewhere).
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  badFrames,
  dragRects,
  installProbe,
  nativeFrames,
  type NativeRun,
  type ProbeReport,
  probeReport,
  resetProbe,
  waitForQuiet,
  waitFrames,
  type WindowStep,
} from "./frames";
import { type RunningApp, Sandbox, sleep, waitFor, type WindowRect, windowRect } from "./harness";
import { openWorkspaceMenu, run, shownPanels, waitForFocus, waitForPanels } from "./ui";

let sandbox: Sandbox | undefined;
afterEach(async ({ task }) => {
  await sandbox?.finish(task);
  sandbox = undefined;
});

const framesDir = (name: string) =>
  join(
    process.env.WOLFCMD_E2E_FRAMES ?? resolve(import.meta.dirname, "../screenshots"),
    `frames-${name}`,
  );

/** The PTY resizes debounce for 50 ms after the last change; this is comfortably after it. */
const SETTLE_MS = 400;
/** A step of a drag: about one frame. */
const STEP_MS = 16;
/** Lines of text, so a blank frame is easy to see. */
const FILL = "for /L %i in (1,1,150) do @echo line %i: the quick brown fox jumps over the lazy dog";

/** WolfCmd with WebGL on and the probe watching from the start. */
async function launchWebgl(name: string): Promise<RunningApp> {
  sandbox = new Sandbox(name);
  const app = await sandbox.launch({ webgl: true });
  await installProbe(app.page);
  return app;
}

/** A new terminal (Enter on the empty tab, or a split), filled with text and drawn. */
async function terminal(app: RunningApp, key: string, count: number): Promise<string> {
  const before = new Set(await shownPanels(app.page));
  await app.page.keyboard.press(key);
  const panels = await waitForPanels(app.page, count);
  const panel = panels.find((id) => !before.has(id));
  if (panel === undefined) throw new Error("no new panel");
  await waitForFocus(app.page, panel);
  await waitForQuiet(app.page);
  await run(app.page, FILL);
  await waitForQuiet(app.page);
  return panel;
}

/** Every shown terminal renders with WebGL (the scenario measures what users run). */
async function expectWebgl(app: RunningApp, panels: readonly string[]) {
  const report = await probeReport(app.page);
  expect([...report.webglPanels].sort()).toEqual([...panels].sort());
}

/** Waits for the resizes to settle and returns what the probe saw. */
async function settled(app: RunningApp) {
  await sleep(SETTLE_MS);
  await waitFrames(app.page, 5);
  return probeReport(app.page);
}

/** Prints what was measured and keeps it as `report.json` next to the captures. */
function logRun(name: string, report: ProbeReport, native?: NativeRun) {
  const bad = native === undefined ? undefined : badFrames(native);
  const summary = {
    frames: report.frames,
    blankFrames: report.blanks.length,
    ptyResizes: report.ptyResizes,
    ptyOpens: report.ptyOpens,
    termResizes: report.termResizes,
    ...(native === undefined || bad === undefined
      ? {}
      : {
          stepsMs: native.elapsed,
          captures: native.frames.length,
          blankCaptures: bad.blank.length,
          flashedCaptures: bad.flash.length,
        }),
  };
  const dir = framesDir(name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "report.json"),
    JSON.stringify({ summary, blanks: report.blanks, bad }, null, 2),
  );
  console.log(`[${name}] ${JSON.stringify(summary)}`);
}

const steps = (rects: readonly WindowRect[], last = SETTLE_MS): WindowStep[] =>
  rects.map((rect, i) => ({ rect, wait: i === rects.length - 1 ? last : STEP_MS }));

describe("N-03 resizing never blinks (WebGL)", () => {
  test("N-03 resizing the window fast from every edge never blanks a terminal; the shells reflow once per drag", async () => {
    const app = await launchWebgl("resize-edges");
    const a = await terminal(app, "Enter", 1);
    const b = await terminal(app, "Alt+Shift+Equal", 2);
    await expectWebgl(app, [a, b]);
    const start = windowRect(app.pid);
    const { x, y, width, height } = start;
    const there = (to: Partial<WindowRect>) => [
      ...dragRects(start, { ...start, ...to }, 20),
      ...dragRects({ ...start, ...to }, start, 20).slice(1),
    ];
    const corner = { x: x - 120, y: y - 80, width: width - 200, height: height - 120 };
    const drags = [
      there({ width: width - 320 }), // the right edge, and back
      there({ height: height - 200 }), // the bottom edge, and back
      there({ x: x + 320, width: width - 320 }), // the left edge, and back
      there({ y: y + 160, height: height - 160 }), // the top edge, and back
      dragRects(start, corner, 30), // the top left corner, to a new size
    ];
    await resetProbe(app.page);
    const native = nativeFrames(
      app.pid,
      drags.flatMap((rects) => steps(rects)),
      { outDir: framesDir("resize-edges"), every: 4 },
    );
    const report = await settled(app);
    logRun("resize-edges", report, native);
    expect(report.blanks).toEqual([]);
    expect(badFrames(native)).toEqual({ blank: [], flash: [] });
    // The terminals followed every step; the shells reflowed once per panel, after the last drag
    // (the others ended at the size they had).
    expect(Object.values(report.termResizes).every((n) => n > drags.length)).toBe(true);
    expect(report.ptyResizes).toBe(2);
    expect(report.ptyOpens).toBe(0);
  });

  test("N-03 maximize, restore, Snap and minimize keep every terminal painted", async () => {
    const app = await launchWebgl("resize-states");
    const a = await terminal(app, "Enter", 1);
    const b = await terminal(app, "Alt+Shift+Minus", 2);
    await expectWebgl(app, [a, b]);
    const start = windowRect(app.pid);
    // Snap to the left half of the work area (physical pixels, like the window's rectangle).
    const work = await app.page.evaluate(() => {
      const s = window.screen as Screen & { availLeft?: number; availTop?: number };
      const scale = window.devicePixelRatio;
      return {
        x: Math.round((s.availLeft ?? 0) * scale),
        y: Math.round((s.availTop ?? 0) * scale),
        width: Math.round(s.availWidth * scale),
        height: Math.round(s.availHeight * scale),
      };
    });
    const left = { ...work, width: Math.round(work.width / 2) };
    // The real pointer may rest on a title once the window is back: its tooltip is not a terminal.
    await app.page.addStyleTag({ content: '[role="tooltip"] { visibility: hidden !important; }' });
    const before = await app.page.screenshot({
      path: join(framesDir("resize-states"), "page-before.png"),
    });
    await resetProbe(app.page);
    const native = nativeFrames(
      app.pid,
      [
        { show: "maximize", wait: 500 },
        { show: "restore", wait: 500 },
        { rect: left, wait: 500 },
        { rect: start, wait: 500 },
        { show: "minimize", wait: 600 },
        { show: "restore", wait: 600 },
      ],
      { outDir: framesDir("resize-states") },
    );
    const report = await settled(app);
    logRun("resize-states", report, native);
    expect(report.blanks).toEqual([]);
    expect(badFrames(native)).toEqual({ blank: [], flash: [] });
    // Nothing was mounted again, and the text stayed where it was.
    expect(report.ptyOpens).toBe(0);
    // The same pixels as at the start (the cursor blinks: wait for its phase).
    await waitFor(
      "the window to look as it did at the start",
      async () => {
        const after = await app.page.screenshot({
          path: join(framesDir("resize-states"), "page-after.png"),
        });
        return after.equals(before);
      },
      5_000,
    );
  });

  test("N-03 dragging a divider never blanks a terminal; the shells reflow once, on release", async () => {
    const app = await launchWebgl("resize-divider");
    const a = await terminal(app, "Enter", 1);
    const b = await terminal(app, "Alt+Shift+Equal", 2);
    await expectWebgl(app, [a, b]);
    const divider = await app.page.locator("[data-divider]").first().boundingBox();
    if (divider === null) throw new Error("no divider");
    const cx = divider.x + divider.width / 2;
    const cy = divider.y + divider.height / 2;
    await resetProbe(app.page);
    await app.page.mouse.move(cx, cy);
    await app.page.mouse.down();
    for (let i = 1; i <= 30; i++) {
      await app.page.mouse.move(cx - i * 8, cy);
      await sleep(STEP_MS);
    }
    for (let i = 29; i >= -20; i--) {
      await app.page.mouse.move(cx - i * 8, cy);
      await sleep(STEP_MS);
    }
    await app.page.mouse.up();
    const report = await settled(app);
    logRun("resize-divider", report);
    expect(report.blanks).toEqual([]);
    expect(report.ptyResizes).toBeLessThanOrEqual(2);
    expect(report.ptyOpens).toBe(0);
  });

  test("N-03 opening and closing a split never blanks the terminal that stays", async () => {
    const app = await launchWebgl("resize-split");
    const a = await terminal(app, "Enter", 1);
    await resetProbe(app.page);
    for (let i = 0; i < 2; i++) {
      await app.page.keyboard.press("Alt+Shift+Equal");
      const [, second] = await waitForPanels(app.page, 2);
      if (second === undefined) throw new Error("no split");
      await waitForFocus(app.page, second);
      await waitForQuiet(app.page);
      await app.page.keyboard.press("Control+Shift+W");
      await waitForPanels(app.page, 1);
      await waitForQuiet(app.page);
    }
    const report = await settled(app);
    logRun("resize-split", report);
    expect(report.blanks.filter((blank) => blank.panel === a)).toEqual([]);
    expect(report.ptyOpens).toBe(2); // the two new panels, never `a` again
  });

  test("N-03 terminals of hidden tabs and workspaces come back painted, never empty", async () => {
    const app = await launchWebgl("resize-tabs");
    const { page } = app;
    const a = await terminal(app, "Enter", 1);
    await page.keyboard.press("Control+Shift+T");
    await page.getByRole("button", { name: "Open a terminal (Enter)" }).waitFor();
    const b = await terminal(app, "Enter", 1);
    await page.keyboard.press("Control+Shift+N");
    await page.getByRole("button", { name: "Open a terminal (Enter)" }).waitFor();
    const c = await terminal(app, "Enter", 1);
    await resetProbe(page);
    const shown = async (panel: string) => {
      await waitFor(`panel ${panel} shown`, async () => (await shownPanels(page)).includes(panel));
      await waitFrames(page, 10);
    };
    for (let i = 0; i < 3; i++) {
      // The other workspace (the menu), its tabs (Ctrl+Tab), then back here.
      await openWorkspaceMenu(page);
      await page.getByRole("menuitemradio", { name: "Workspace 1" }).click();
      await shown(b);
      await page.keyboard.press("Control+Tab");
      await shown(a);
      await page.keyboard.press("Control+Tab");
      await shown(b);
      await openWorkspaceMenu(page);
      await page.getByRole("menuitemradio", { name: "Workspace 2" }).click();
      await shown(c);
    }
    const report = await settled(app);
    logRun("resize-tabs", report);
    expect(report.blanks).toEqual([]);
    expect(report.ptyOpens).toBe(0);
    // Coming back reflows nothing: the shells keep their size.
    expect(report.ptyResizes).toBe(0);
  });
});
