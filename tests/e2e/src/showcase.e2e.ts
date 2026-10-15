// N-06 showcase (opt-in: `WOLFCMD_SHOWCASE=<folder>`): a typical session with agents, screenshot by
// screenshot, for a person to look at; it checks only what it waits for. Never a real agent:
// stand-in `claude.cmd` and `codex.cmd` run a PowerShell script that, for each line typed, sets
// the agent's working title (Claude Code ◐ / ◑, Codex a Braille spinner) and prints a few steps,
// then sets its idle title and waits again. N-06: the finish reward (each agent's panel glowing in
// its color) is frozen at chosen moments (its animations paused and sought) for stills and a frame
// sequence.
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "playwright-core";
import { afterEach, describe, test } from "vitest";

import { type RunningApp, Sandbox, waitFor, writeText } from "./harness";
import { waitForFocus, waitForPanels, waitForScreen, waitForTabs } from "./ui";

const OUT = process.env.WOLFCMD_SHOWCASE;

let sandbox: Sandbox | undefined;
afterEach(async ({ task }) => {
  await sandbox?.finish(task);
  sandbox = undefined;
});

async function shot(app: RunningApp, name: string): Promise<void> {
  const path = await app.screenshot(`showcase-${name}`);
  if (OUT !== undefined) {
    mkdirSync(OUT, { recursive: true });
    copyFileSync(path, join(OUT, `${name}.png`));
  }
}

const stubCmd = (kind: string) =>
  `@echo off\r\nif "%~1"=="--version" exit /b 0\r\n` +
  `powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0showcase-agent.ps1" ${kind}\r\n`;

// Glyphs by code point: Windows PowerShell reads a BOM-less script as ANSI.
const AGENT_PS1 = [
  "param([string]$kind)",
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
  "$dot = [string][char]0x25CF; $hook = [string][char]0x23BF; $bullet = [string][char]0x2022; $corner = [string][char]0x2514",
  "if ($kind -eq 'claude') {",
  "  $frames = @([string][char]0x25D0, [string][char]0x25D1); $idle = [string][char]0x2733; $name = 'Claude Code'",
  "  $steps = @(",
  '    "$dot Read(src/auth/session.ts)", "  $hook  Read 142 lines",',
  '    "$dot Update(src/auth/session.ts)", "  $hook  Updated with 12 additions and 3 removals",',
  '    "$dot Bash(pnpm test auth)", "  $hook  42 passed")',
  "} else {",
  "  $frames = @(0x280B, 0x2819, 0x2839, 0x2838, 0x283C, 0x2834) | ForEach-Object { [string][char]$_ }; $idle = ''; $name = 'codex'",
  "  $steps = @(",
  '    "$bullet Explored", "  $corner Read README.md, docs/guide.md",',
  '    "$bullet Edited docs/guide.md (+8 -2)",',
  '    "$bullet Ran pnpm lint", "  $corner no problems")',
  "}",
  '$Host.UI.RawUI.WindowTitle = "$idle $name".Trim()',
  '[Console]::WriteLine("$name is ready (a demo stand-in).")',
  "while ($true) {",
  "  $line = [Console]::ReadLine()",
  "  if ($null -eq $line) { break }",
  "  [Console]::WriteLine('')",
  "  $f = 0",
  "  foreach ($step in $steps) {",
  "    for ($t = 0; $t -lt 6; $t++) {",
  '      $Host.UI.RawUI.WindowTitle = "$($frames[$f % $frames.Length]) $line"',
  "      $f++",
  "      Start-Sleep -Milliseconds 250",
  "    }",
  "    [Console]::WriteLine($step)",
  "  }",
  '  [Console]::WriteLine("")',
  '  [Console]::WriteLine("$dot Done: $line.")',
  '  [Console]::WriteLine("")',
  '  $Host.UI.RawUI.WindowTitle = "$idle $line".Trim()',
  "}",
].join("\r\n");

const setTheme = (page: Page, theme: "dark" | "light") =>
  page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);

const activity = (page: Page, selector: string) =>
  page.evaluate(
    (s) => [...document.querySelectorAll(s)].map((e) => e.getAttribute("data-activity")).join(" "),
    selector,
  );

/** The finish glows' animations (the panels' and the tab pills'): paused at `ms`. */
const freezeGlow = (page: Page, ms: number) =>
  page.evaluate((at) => {
    const glows = [...document.querySelectorAll("[data-panel-glow], [data-pill-glow]")];
    for (const animation of document.getAnimations()) {
      const target = (animation.effect as KeyframeEffect | null)?.target;
      if (target instanceof Element && glows.some((glow) => glow.contains(target))) {
        animation.pause();
        animation.currentTime = at;
      }
    }
  }, ms);

/** Lets the frozen glows end (their `animationend` makes them quiet again). */
const endGlow = (page: Page) =>
  page.evaluate(() => {
    const glows = [...document.querySelectorAll("[data-panel-glow], [data-pill-glow]")];
    for (const animation of document.getAnimations()) {
      const target = (animation.effect as KeyframeEffect | null)?.target;
      if (target instanceof Element && glows.some((glow) => glow.contains(target))) {
        animation.finish();
      }
    }
  });

/** The panel glow's length (`--wc-dur-finish-glow`) in ms. */
const glowLength = (page: Page) =>
  page.evaluate(() => {
    // The build may write it in seconds ("1.6s").
    const value = getComputedStyle(document.documentElement)
      .getPropertyValue("--wc-dur-finish-glow")
      .trim();
    const n = Number.parseFloat(value);
    return value.endsWith("ms") ? n : n * 1000;
  });

async function say(page: Page, panel: string, line: string) {
  await page.locator(`[data-panel="${panel}"] .xterm`).click();
  await waitForFocus(page, panel);
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

describe.skipIf(OUT === undefined)("N-06 showcase", () => {
  test("N-06 showcase: a session with Claude Code and Codex", async () => {
    const box = (sandbox = new Sandbox("showcase"));
    const project = box.folder("wolfcmd-demo");
    for (const dir of [box.binDir, project]) {
      writeText(join(dir, "claude.cmd"), stubCmd("claude"));
      writeText(join(dir, "codex.cmd"), stubCmd("codex"));
      writeText(join(dir, "showcase-agent.ps1"), AGENT_PS1);
    }
    writeText(box.dataFile("settings.toml"), "[agents]\nnotify_when_done = false\n");
    writeText(
      box.dataFile("workspaces.json"),
      JSON.stringify({
        version: 2,
        active: "w-demo",
        workspaces: [
          {
            id: "w-demo",
            name: "",
            folder: project,
            activeTab: "t-agents",
            tabs: [
              { id: "t-agents", name: "Agents", layout: null },
              { id: "t-shell", name: "Build", layout: null },
            ],
          },
        ],
      }),
    );
    // Shells show a neutral prompt, not the sandbox's temp path (it names the user's folder).
    const app = await box.launch({ env: { PROMPT: "C:\\dev\\wolfcmd-demo$G" } });
    const { page } = app;

    // 1. An empty tab: a terminal or an agent.
    await page.getByRole("button", { name: "Claude Code" }).waitFor();
    await shot(app, "01-empty-tab");

    // 2. The Agents button on the right.
    await page.getByRole("button", { name: "Agents" }).click();
    await page.getByRole("menuitem", { name: "Claude Code" }).waitFor();
    await shot(app, "02-agents-menu");
    await page.getByRole("menuitem", { name: "Claude Code" }).click();
    const [claude = ""] = await waitForPanels(page, 1);
    await waitForScreen(page, claude, /Claude Code is ready/, { joined: true });

    // 3. Codex beside it.
    await page.getByRole("button", { name: "Agents" }).click();
    await page.getByRole("menuitem", { name: "Codex" }).click();
    const both = await waitForPanels(page, 2);
    const codex = both.find((p) => p !== claude) ?? "";
    await waitForScreen(page, codex, /codex is ready/, { joined: true });
    await shot(app, "03-two-agents-ready");

    // 4. Both at work.
    await say(page, codex, "update the setup guide");
    await say(page, claude, "fix the login bug");
    await waitFor(
      "both working",
      async () => (await activity(page, "[data-panel-header] [data-activity]")) !== "",
    );
    await page.waitForTimeout(1_500);
    await shot(app, "04-both-working");
    await setTheme(page, "light");
    await shot(app, "04-both-working-light");
    await setTheme(page, "dark");

    // 5. Away in another tab: the Agents tab's pill shows the work, glows once when it's done,
    // then keeps a check until the tab is shown again.
    await page.locator("header [role=tab]").nth(1).click();
    await waitForTabs(page, 2, 1);
    await waitFor("the working pill", async () =>
      (await activity(page, "header [role=tab] [data-activity]")).includes("working"),
    );
    await shot(app, "05-away-working");
    await page.locator("header [data-pill-glow][data-glowing]").waitFor({ timeout: 30_000 });
    const length = await glowLength(page);
    await freezeGlow(page, length * 0.3);
    await shot(app, "06-finished-glow");
    // N-06: the agents' panels are out of sight: their glows wait for the tab.
    await endGlow(page);
    await waitFor("both done", async () => {
      const marks = await activity(page, "header [role=tab] [data-activity]");
      return marks.includes("done") && !marks.includes("working");
    });
    await page.locator("header [data-pill-glow][data-glowing]").waitFor({ state: "detached" });
    await shot(app, "07-finished-mark");

    // 6. Back: each agent's panel glows once in its own color, then the results.
    await page.locator("header [role=tab]").first().click();
    await waitForTabs(page, 2, 0);
    await waitFor(
      "both panels glowing",
      async () => (await page.locator("[data-panel-glow][data-glowing]").count()) === 2,
      5_000,
    );
    await freezeGlow(page, length * 0.4);
    await shot(app, "06b-panel-glow");
    await setTheme(page, "light");
    await shot(app, "06c-panel-glow-light");
    await setTheme(page, "dark");
    // The motion, frame by frame (every tenth of the glow).
    for (let frame = 0; frame <= 10; frame++) {
      await freezeGlow(page, (length * frame) / 10);
      await shot(app, `glow-frames-${String(frame).padStart(2, "0")}`);
    }
    await endGlow(page);
    await page.locator("[data-panel-glow][data-glowing]").first().waitFor({ state: "detached" });
    await shot(app, "08-back-results");

    // 7. One agent maximized while it works.
    await say(page, claude, "add tests for the session refresh");
    await page.keyboard.press("Control+Shift+Enter");
    await page.waitForTimeout(1_500);
    await shot(app, "09-maximized-working");
    await page.keyboard.press("Control+Shift+Enter");

    // 8. Another workspace while the agent works: the switcher shows it.
    await say(page, codex, "check the changelog");
    await page.keyboard.press("Control+Shift+N");
    await waitFor(
      "the switcher's dot",
      async () => (await activity(page, "header button [data-activity]")) !== "",
    );
    await page.locator("header button").first().click();
    await page.getByRole("menuitemradio").first().waitFor();
    await shot(app, "10-switcher-working");
    await page.keyboard.press("Escape");
  });
});
