// N-02: a full-screen agent's redraws are painted as xterm's buffer holds them (WebGL on).
//
// A reported bug: in an agent panel, after /theme then /model, rows of the old list stayed
// on screen and areas stayed empty until the pointer moved over them. A stand-in for such an agent
// (a node script: the alternate screen, synchronized output (DEC 2026), only the changed rows
// rewritten, mouse motion reported and the hovered row drawn again) switches between a theme list
// and a model list on its own while the scenario does what a user does around it: another tab and
// back, a split, maximize and restore, Settings, the Agents menu, the pointer over the rows. After
// each step the stand-in holds still and `stalePaint` (`painted.ts`) compares the painted rows with
// a fresh render of the buffer; the stand-in prints the size its PTY has, which must be the
// terminal's. A last step proves the check sees a missed paint.
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "playwright-core";
import { afterEach, describe, expect, test } from "vitest";

import { installProbe, waitForQuiet } from "./frames";
import { Sandbox, sleep } from "./harness";
import { bufferRows, findTerminals, holdRendering, stalePaint, withTerminal } from "./painted";
import { run, shownPanels, waitForFocus, waitForPanels } from "./ui";

let sandbox: Sandbox | undefined;
afterEach(async ({ task }) => {
  await sandbox?.finish(task);
  sandbox = undefined;
});

/** The stand-in agent: `a` starts its own redraws (every 90 ms), a `pause` file next to it holds them. */
const AGENT_JS = String.raw`
const fs = require("fs");
const path = require("path");
const out = process.stdout;
const E = "\x1b";
const PAUSE = path.join(__dirname, "pause");
let rows = out.rows, cols = out.columns, prev = [], dialog, selected = 0, hover = -1, tick = 0, auto;
const lists = {
  theme: ["Auto (match terminal)", "Dark mode", "Light mode", "Dark mode (colorblind)", "Light mode (colorblind)"],
  model: ["1. Default (recommended)  Best for everyday tasks", "2. Large model            For complex work",
    "3. Larger model           For the toughest challenges", "4. Medium model           Efficient for simple tasks",
    "5. Small model            Fastest for quick answers", "6. Older medium           Efficient for routine tasks",
    "7. Older large            Best for everyday tasks", "8. Oldest large           For the hardest tasks"],
};
function frame() {
  const top = ["  ##  ##   Stand-in agent", "  ######   C:\\work", ""];
  const bottom = [];
  if (dialog) {
    bottom.push(dialog === "theme" ? " Theme" : " Select model", "");
    lists[dialog].forEach((item, i) => {
      const y = rows - lists[dialog].length - 6 + i;
      bottom.push((i === selected ? E + "[44m > " : y === hover ? E + "[100m   " : "   ") + item + E + "[0m");
    });
    bottom.push("");
  }
  const rule = "-".repeat(Math.min(cols - 1, 60));
  bottom.push(rule, dialog ? "> /" + dialog : "> ", rule, "  pty=" + cols + "x" + rows + " frame " + tick);
  return [...top, ...Array(Math.max(0, rows - top.length - bottom.length)).fill(""), ...bottom].slice(0, rows);
}
function draw() {
  const next = frame();
  let s = E + "[?2026h";
  for (let y = 0; y < rows; y++) if (prev[y] !== next[y]) s += E + "[" + (y + 1) + ";1H" + next[y] + E + "[K";
  out.write(s + E + "[?2026l");
  prev = next;
}
function step() {
  if (fs.existsSync(PAUSE)) return;
  tick += 1;
  const r = tick % 6;
  if (r === 0) { dialog = "theme"; selected = 1; } else if (r === 1) selected = 2;
  else if (r === 2) dialog = undefined; else if (r === 3) { dialog = "model"; selected = 0; }
  else if (r === 4) selected = 5; else dialog = undefined;
  draw();
}
out.write(E + "[?1049h" + E + "[?25l" + E + "[2J" + E + "[?1003h" + E + "[?1006h");
draw();
process.stdin.setRawMode(true);
process.stdin.on("data", (data) => {
  const text = data.toString();
  const mouse = [...text.matchAll(/\x1b\[<\d+;\d+;(\d+)[mM]/g)].at(-1);
  if (mouse) hover = Number(mouse[1]) - 1;
  else if (text === "a") auto ??= setInterval(step, 90);
  draw();
});
out.on("resize", () => { rows = out.rows; cols = out.columns; prev = []; out.write(E + "[2J"); draw(); });
`;

/** The panel's terminal size and the size the stand-in's PTY reports on its last row. */
async function sizes(page: Page, panel: string) {
  const rows = await bufferRows(page, panel);
  const pty = /pty=(\d+x\d+)/.exec(rows.join("\n"))?.[1];
  const term = await withTerminal(
    page,
    panel,
    (t) => `${String(t.cols)}x${String(t.rows)}`,
    undefined,
  );
  return { term, pty };
}

describe("N-02 a full-screen agent's redraws are painted (WebGL)", () => {
  test("N-02 the rows a full-screen agent rewrites are painted as the buffer holds them, around tabs, splits, maximize and menus", async () => {
    sandbox = new Sandbox("repaint");
    const app = await sandbox.launch({ webgl: true });
    const { page } = app;
    await installProbe(page);
    await page.getByRole("button", { name: /Open a terminal/ }).click();
    const [panel] = await waitForPanels(page, 1);
    if (panel === undefined) throw new Error("no panel");
    await waitForFocus(page, panel);
    await waitForQuiet(page);
    const script = join(sandbox.root, "agent.js");
    const pause = join(sandbox.root, "pause");
    writeFileSync(script, AGENT_JS);
    await run(page, `"${process.execPath}" "${script}"`);
    await sleep(1_500);
    await page.keyboard.press("a");

    const seen: Record<string, unknown> = {};
    const check = async (what: string) => {
      await sleep(1_000); // the stand-in redraws on its own meanwhile
      writeFileSync(pause, "");
      await sleep(200);
      await waitForQuiet(page, 300, 5_000);
      await findTerminals(page);
      const size = await sizes(page, panel);
      seen[what] = { stale: await stalePaint(page, panel), sizesMatch: size.term === size.pty };
      rmSync(pause, { force: true });
    };
    const closeOther = async () => {
      const other = (await shownPanels(page)).find((id) => id !== panel);
      if (other === undefined) return;
      await page.locator(`[data-panel="${other}"] .xterm-screen`).click();
      await page.keyboard.press("Control+Shift+W");
      await waitForPanels(page, 1);
    };

    await check("redraws");
    await page.keyboard.press("Control+Shift+T");
    await sleep(700);
    await page.keyboard.press("Control+Tab");
    await check("another tab and back");
    await page.keyboard.press("Alt+Shift+Equal");
    await waitForPanels(page, 2);
    await check("a split beside it");
    await page.locator(`[data-panel="${panel}"] .xterm-screen`).click({ position: { x: 4, y: 4 } });
    await page.keyboard.press("Control+Shift+Enter");
    await check("maximized");
    await page.keyboard.press("Control+Shift+Enter");
    await check("restored");
    await closeOther();
    await check("the split closed");
    await page.keyboard.press("Control+Comma");
    await sleep(600);
    await page.keyboard.press("Escape");
    await check("Settings opened and closed");
    await page.getByRole("button", { name: "Agents" }).click();
    await sleep(600);
    await page.keyboard.press("Escape");
    await check("the Agents menu opened and closed");
    const box = await page.locator(`[data-panel="${panel}"] .xterm-screen`).boundingBox();
    if (box === null) throw new Error("no screen");
    for (let y = 0; y < 12; y++)
      await page.mouse.move(box.x + 120, box.y + box.height - 30 - y * 18);
    await check("the pointer over the rows");
    await app.screenshot("repaint");

    const clean = { stale: [], sizesMatch: true };
    expect(seen).toEqual(Object.fromEntries(Object.keys(seen).map((what) => [what, clean])));

    // The check sees a missed paint: while xterm's rendering is held, the stand-in's next frames
    // reach the buffer but not the screen.
    await holdRendering(page, panel, true);
    rmSync(pause, { force: true });
    await sleep(400);
    writeFileSync(pause, "");
    await sleep(300);
    // The screen is captured while still held, then the hold is released in the same step as the
    // full redraw: a routine refresh (a cursor blink) can't repaint the rows in between.
    expect(await stalePaint(page, panel, { release: true })).not.toEqual([]);
  });
});
