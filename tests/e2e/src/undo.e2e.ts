// N-11 end to end: closing a running agent asks first; undo (Ctrl+Shift+Z) brings a closed panel
// or tab back with its session still running, redo (Ctrl+Shift+Y) closes it again, and an undo
// in another tab says so in a small notice. Never a real agent: the stand-in of `stub-agent.ts`.
import type { Page } from "playwright-core";
import { afterEach, describe, expect, test } from "vitest";

import { Sandbox, writeText } from "./harness";
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

/** The close question, if one is shown. */
const question = (page: Page) => page.getByRole("dialog");

/** Types `line` into the focused panel and presses Enter. */
async function say(page: Page, line: string) {
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

describe("N-11 undo and the close question", () => {
  test("N-11 closing a running agent asks: Cancel keeps it, Close then Ctrl+Shift+Z brings it back running", async () => {
    const box = (sandbox = new Sandbox("undo-agent"));
    const project = box.folder("project");
    installStubAgent(box.binDir, project);
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
    await say(page, "remember this");
    await waitForScreen(page, agent, /^done remember this$/m, { timeout: 15_000 });

    // A plain shell at its prompt closes without asking (and comes back with Ctrl+Shift+Z).
    await page.locator(`[data-panel="${shell}"] .xterm`).click();
    await waitForFocus(page, shell);
    await page.keyboard.press("Control+Shift+W");
    await waitForPanels(page, 1);
    expect(await question(page).count()).toBe(0);
    await page.keyboard.press("Control+Shift+Z");
    await waitForPanels(page, 2);
    await waitForScreen(page, shell, /^stub-claude --version$/m);

    // The agent asks; Cancel has the focus, so Enter keeps the panel.
    await page.locator(`[data-panel="${agent}"] .xterm`).click();
    await waitForFocus(page, agent);
    await page.keyboard.press("Control+Shift+W");
    await question(page).waitFor();
    expect(await question(page).innerText()).toContain("Claude Code is still running in it.");
    await app.screenshot("n11-1-close-question");
    await page.keyboard.press("Enter");
    await question(page).waitFor({ state: "detached" });
    expect((await shownPanels(page)).sort()).toEqual([shell, agent].sort());

    // Close it, then undo: the same panel comes back with its screen, the agent still running.
    await page.keyboard.press("Control+Shift+W");
    await question(page).getByRole("button", { name: "Close", exact: true }).click();
    await waitForPanels(page, 1);
    const undo = page.locator('header button[aria-label^="Undo close panel"]');
    await undo.waitFor();
    await page.keyboard.press("Control+Shift+Z");
    expect((await waitForPanels(page, 2)).sort()).toEqual([shell, agent].sort());
    await waitForScreen(page, agent, /^done remember this$/m);
    await page.locator(`[data-panel="${agent}"] .xterm`).click();
    await waitForFocus(page, agent);
    await say(page, "still here");
    await waitForScreen(page, agent, /^working on still here 0$/m, { timeout: 15_000 });
    await app.screenshot("n11-2-agent-restored");

    // Redo closes it again (no question: the close was answered).
    await page.keyboard.press("Control+Shift+Y");
    await waitForPanels(page, 1);
    expect(await question(page).count()).toBe(0);
    await app.quit();
  });

  test("N-11 a closed tab comes back with Ctrl+Shift+Z, goes again with Ctrl+Shift+Y; an undo elsewhere says so", async () => {
    const box = (sandbox = new Sandbox("undo-tab"));
    const app = await box.launch();
    const { page } = app;

    await page.getByRole("button", { name: "Open a terminal (Enter)" }).waitFor();
    await page.keyboard.press("Enter");
    const [first = ""] = await waitForPanels(page, 1);
    await waitForPrompt(page, first);
    await page.keyboard.press("Control+Shift+T");
    await waitForTabs(page, 2, 1);
    await page.getByRole("button", { name: "Open a terminal (Enter)" }).waitFor();
    await page.keyboard.press("Enter");
    const [second = ""] = await waitForPanels(page, 1);
    await waitForPrompt(page, second);
    await run(page, "echo second-tab-text");
    await waitForScreen(page, second, /^second-tab-text$/m);

    // Close the shown tab with its ✕ (a shell at its prompt: no question).
    const pill = page.locator("header [role=tab]").nth(1);
    await pill.hover();
    await pill.getByRole("button", { name: "Close tab" }).click();
    await waitForTabs(page, 1, 0);
    expect(await question(page).count()).toBe(0);

    // The undo button names it; Ctrl+Shift+Z brings the tab back, shown, its shell running.
    await page.locator('header button[aria-label^="Undo close tab"]').waitFor();
    await page.keyboard.press("Control+Shift+Z");
    await waitForTabs(page, 2, 1);
    expect(await waitForPanels(page, 1)).toEqual([second]);
    await waitForScreen(page, second, /^second-tab-text$/m);
    await page.locator(`[data-panel="${second}"] .xterm`).click();
    await run(page, "echo after-undo");
    await waitForScreen(page, second, /^after-undo$/m);

    // Redo closes it again; undo brings it back once more.
    await page.locator('header button[aria-label^="Redo close tab"]').waitFor();
    await page.keyboard.press("Control+Shift+Y");
    await waitForTabs(page, 1, 0);
    await page.keyboard.press("Control+Shift+Z");
    await waitForTabs(page, 2, 1);
    await waitForScreen(page, second, /^after-undo$/m);

    // A split in the second tab, undone from the first tab: off screen, so a notice says so.
    await page.locator(`[data-panel="${second}"] .xterm`).click();
    await page.keyboard.press("Alt+Shift+Equal");
    await waitForPanels(page, 2);
    await page.locator("header [role=tab]").first().click();
    await waitForTabs(page, 2, 0);
    await page.keyboard.press("Control+Shift+Z");
    await page.getByRole("status").filter({ hasText: "Undone: split right" }).waitFor();
    await app.screenshot("n11-3-undo-notice");
    await waitForTabs(page, 2, 0);
    await page.locator("header [role=tab]").nth(1).click();
    expect(await waitForPanels(page, 1)).toEqual([second]);
    await app.quit();
  });
});
