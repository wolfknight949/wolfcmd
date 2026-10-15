// N-06 end to end: an agent working and finishing, seen on its tab pill, its panel header, its
// panel's finish glow and the workspace switcher. Never a real agent: the stand-in of
// `stub-agent.ts` works 4 s per typed line.
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "playwright-core";
import { afterEach, describe, expect, test } from "vitest";

import { type RunningApp, Sandbox, waitFor, writeText } from "./harness";
import { installStubAgent } from "./stub-agent";
import {
  run,
  shownPanels,
  waitForFocus,
  waitForPanels,
  waitForPrompt,
  waitForScreen,
  waitForTabs,
} from "./ui";

let sandbox: Sandbox | undefined;
afterEach(async ({ task }) => {
  await sandbox?.finish(task);
  sandbox = undefined;
});

/** Where the scenario's screenshots are copied (`WOLFCMD_E2E_ACTIVITY_SHOTS`), if set. */
const SHOTS = process.env.WOLFCMD_E2E_ACTIVITY_SHOTS;

async function shot(app: RunningApp, name: string): Promise<void> {
  const path = await app.screenshot(name);
  if (SHOTS !== undefined) {
    mkdirSync(SHOTS, { recursive: true });
    copyFileSync(path, join(SHOTS, `${name}.png`));
  }
}

/** The agent marks inside the `index`th tab pill. */
const pillMarks = (page: Page, index: number) =>
  page.evaluate((i) => {
    const pill = document.querySelectorAll("header [role=tab]").item(i) as Element | null;
    return [...(pill?.querySelectorAll("[data-activity]") ?? [])].map((e) =>
      e.getAttribute("data-activity"),
    );
  }, index);

/** The agent mark in a panel's header. */
const headerMark = (page: Page, panel: string) =>
  page.evaluate(
    (id) =>
      document
        .querySelector(`[data-panel="${id}"] [data-panel-header] [data-activity]`)
        ?.getAttribute("data-activity") ?? null,
    panel,
  );

const switcherMark = (page: Page) =>
  page.evaluate(
    () =>
      document.querySelector("header button [data-activity]")?.getAttribute("data-activity") ??
      null,
  );

/** N-06: the finish glow playing on a panel's own block. */
const panelGlow = (page: Page, panel: string) =>
  page.locator(`[data-panel="${panel}"] [data-panel-glow][data-glowing]`);

const setTheme = (page: Page, theme: "dark" | "light") =>
  page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);

/** Types `line` into the focused panel and presses Enter. */
async function say(page: Page, line: string) {
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

describe("N-06 agent activity", () => {
  test("N-06 an agent in a background tab shows working on its pill, glows when done, and showing the tab clears it", async () => {
    const box = (sandbox = new Sandbox("activity"));
    const project = box.folder("project");
    installStubAgent(box.binDir, project);
    // No system notifications from a test run.
    writeText(box.dataFile("settings.toml"), "[agents]\nnotify_when_done = false\n");
    const app = await box.launch();
    const { page } = app;

    await page.getByRole("button", { name: "Open a terminal (Enter)" }).waitFor();
    await page.keyboard.press("Enter");
    const [shell = ""] = await waitForPanels(page, 1);
    await waitForPrompt(page, shell);
    await run(page, `cd /d "${project}"`);
    await waitForScreen(page, shell, /project>$/, { joined: true });
    // Never the real agent: `claude` here must run the stand-in.
    await run(page, "claude --version");
    await waitForScreen(page, shell, /^stub-claude --version$/m);

    await page.getByRole("button", { name: "Agents" }).click();
    await page.getByRole("menuitem", { name: "Claude Code" }).click();
    const panels = await waitForPanels(page, 2);
    const agent = panels.find((p) => p !== shell) ?? "";
    await waitForFocus(page, agent);
    await waitForScreen(page, agent, /stub-claude --session-id/, { joined: true });
    // The stand-in waits; nothing is marked yet.
    expect(await pillMarks(page, 0)).toEqual([]);

    // 1. The agent works while its tab is hidden: the pill says so, then glows and keeps a mark.
    await say(page, "fix the login bug");
    await page.keyboard.press("Control+Shift+T");
    await waitForTabs(page, 2, 1);
    await waitFor("the working mark on the hidden tab's pill", async () =>
      (await pillMarks(page, 0)).includes("working"),
    );
    await shot(app, "n06-1-pill-working-dark");
    await page.locator("header [data-pill-glow][data-glowing]").waitFor({ timeout: 15_000 });
    await shot(app, "n06-2-pill-glow-dark");
    // N-06: its panel is out of sight, so its glow waits.
    expect(await page.locator("[data-panel-glow][data-glowing]").count()).toBe(0);
    await waitFor("the done mark", async () => (await pillMarks(page, 0)).includes("done"));
    // The glow plays once.
    await page.locator("header [data-pill-glow][data-glowing]").waitFor({ state: "detached" });
    await shot(app, "n06-3-pill-done-dark");
    await setTheme(page, "light");
    await shot(app, "n06-3-pill-done-light");
    await setTheme(page, "dark");

    // Showing the tab clears it (the agent's panel is the focused one: the header too), and
    // N-06 the agent's own panel glows once now that the user can see it.
    await page.locator("header [role=tab]").first().click();
    await waitForTabs(page, 2, 0);
    await panelGlow(page, agent).waitFor({ timeout: 5_000 });
    expect(await page.locator("[data-panel-glow][data-glowing]").count()).toBe(1);
    await waitFor("the marks cleared", async () => (await pillMarks(page, 0)).length === 0);
    expect(await headerMark(page, agent)).toBeNull();

    // 2. Working in the shown tab while the shell has the focus: the header and pill show it;
    // when it finishes the header keeps a check until the agent's panel is looked at.
    await page.locator(`[data-panel="${agent}"] .xterm`).click();
    await say(page, "add tests");
    await page.locator(`[data-panel="${shell}"] .xterm`).click();
    await waitForFocus(page, shell);
    await waitFor(
      "the header's working dot",
      async () => (await headerMark(page, agent)) === "working",
    );
    await shot(app, "n06-4-header-working-dark");
    await setTheme(page, "light");
    await shot(app, "n06-4-header-working-light");
    await setTheme(page, "dark");
    await waitFor(
      "the header's finished mark",
      async () => (await headerMark(page, agent)) === "finished",
      15_000,
    );
    // Seen in its tab: no pill mark; N-06 its panel glows at once (on screen, not focused).
    expect(await pillMarks(page, 0)).toEqual([]);
    await panelGlow(page, agent).waitFor({ timeout: 5_000 });
    await shot(app, "n06-5-header-finished-dark");
    await page.locator(`[data-panel="${agent}"] .xterm`).click();
    await waitFor("the header cleared", async () => (await headerMark(page, agent)) === null);
    await panelGlow(page, agent).waitFor({ state: "detached" });

    // N-06: a finish in the panel the user looks at: nothing glows.
    await say(page, "rename a variable");
    await waitFor(
      "the header's spinner",
      async () => (await headerMark(page, agent)) === "working",
    );
    await waitFor(
      "the agent idle again",
      async () => (await headerMark(page, agent)) === null,
      15_000,
    );
    expect(await page.locator("[data-panel-glow][data-glowing]").count()).toBe(0);

    // 3. The agent works in a hidden workspace: the switcher shows a dot and the row says so.
    await say(page, "update the docs");
    await page.keyboard.press("Control+Shift+N");
    await waitFor("the switcher's dot", async () => (await switcherMark(page)) === "working");
    await page.locator("header button").first().click();
    const row = page.getByRole("menuitemradio").filter({ hasText: "Working" });
    await row.waitFor();
    await shot(app, "n06-6-switcher-working-dark");
    await setTheme(page, "light");
    await shot(app, "n06-6-switcher-working-light");
    await setTheme(page, "dark");
    await page.keyboard.press("Escape");
    await waitFor(
      "the switcher's done dot",
      async () => (await switcherMark(page)) === "done",
      15_000,
    );
    await shot(app, "n06-7-switcher-done-dark");

    // Back to the agent's workspace: its tab is shown, the marks go.
    await page.locator("header button").first().click();
    await page.getByRole("menuitemradio").filter({ hasText: "Done" }).click();
    await waitFor("the switcher's dot gone", async () => (await switcherMark(page)) === null);
    expect(await shownPanels(page)).toContain(agent);
    // N-06: its panel glows once its workspace is shown.
    await panelGlow(page, agent).waitFor({ timeout: 5_000 });

    // 4. Light theme: working, the glow and the done mark on a hidden tab's pill.
    await setTheme(page, "light");
    await page.locator(`[data-panel="${agent}"] .xterm`).click();
    await say(page, "one more");
    await page.keyboard.press("Control+Shift+T");
    await waitForTabs(page, 3, 2);
    await waitFor("the working mark", async () => (await pillMarks(page, 0)).includes("working"));
    await shot(app, "n06-1-pill-working-light");
    await page.locator("header [data-pill-glow][data-glowing]").waitFor({ timeout: 15_000 });
    await shot(app, "n06-2-pill-glow-light");
    await waitFor("the done mark", async () => (await pillMarks(page, 0)).includes("done"));
  });
});
