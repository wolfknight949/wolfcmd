// N-02 end to end: a terminal never loses or misroutes a key. Long lines typed fast, with no wait
// before the first key, right after the moments that move the keyboard or animate around it: a new
// panel, a click on a panel, a tab pill or a tab shortcut, a menu or flyout closing (Esc, an item,
// a click on a terminal), Settings closing, an agent's spinner and a panel's finish glow. Each
// line must reach the terminal meant (every key, by the probe in the page) and its shell must
// echo it exactly (`keys-probe.ts`).
import { afterEach, describe, test } from "vitest";

import { Sandbox, writeText } from "./harness";
import { installKeysProbe, typeInto } from "./keys-probe";
import { installStubAgent } from "./stub-agent";
import {
  focusedPanel,
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

/** How many times the quick moves (clicks, menus, tabs) repeat. */
const ROUNDS = 3;

describe("N-02 typing", () => {
  test("N-02 every typed key reaches the terminal meant, whatever moved or animated just before", async () => {
    const box = (sandbox = new Sandbox("typing"));
    const project = box.folder("project");
    installStubAgent(box.binDir, project);
    writeText(box.dataFile("settings.toml"), "[agents]\nnotify_when_done = false\n");
    const app = await box.launch();
    const { page } = app;
    await installKeysProbe(page);

    // A new panel settling in: type at once.
    await page.getByRole("button", { name: "Open a terminal (Enter)" }).waitFor();
    await page.keyboard.press("Enter");
    const [first = ""] = await waitForPanels(page, 1);
    await typeInto(page, first, "first-panel");
    await run(page, `cd /d "${project}"`);
    await waitForScreen(page, first, /project>$/, { joined: true });

    // A split settling in next to it.
    await page.keyboard.press("Alt+Shift+Equal");
    const panels = await waitForPanels(page, 2);
    const second = panels.find((p) => p !== first) ?? "";
    await waitForFocus(page, second);
    await typeInto(page, second, "split");

    // A tab of its own, and back and forth by pill and by key.
    await page.keyboard.press("Control+Shift+T");
    await waitForTabs(page, 2, 1);
    await page.keyboard.press("Enter");
    const [third = ""] = await waitForPanels(page, 1);
    await typeInto(page, third, "new-tab");
    const pills = page.locator("header [role=tab]");
    await page.keyboard.press("Control+Shift+Tab");
    await waitForTabs(page, 2, 0);

    for (let round = 1; round <= ROUNDS; round++) {
      // Tabs by key and by pill: the shown tab's focused terminal has the keyboard, never the pill.
      await page.keyboard.press("Control+Tab");
      await waitForTabs(page, 2, 1);
      await typeInto(page, third, `ctrl-tab-${String(round)}`);
      await pills.first().click();
      await waitForTabs(page, 2, 0);
      await typeInto(page, (await focusedPanel(page)) ?? "", `pill-${String(round)}`);
      // Clicks on panels.
      await page.locator(`[data-panel="${first}"] .xterm`).click();
      await typeInto(page, first, `click-${String(round)}`);
      await page.locator(`[data-panel="${second}"] .xterm`).click();
      await typeInto(page, second, `click-again-${String(round)}`);

      // Menus and flyouts closing: the keyboard goes back where it came from.
      await page.getByRole("button", { name: "Agents" }).click();
      await page.getByRole("menu").waitFor();
      await page.keyboard.press("Escape");
      await typeInto(page, second, `agents-esc-${String(round)}`);
      await page.getByRole("menu").waitFor({ state: "detached" });

      await page.getByRole("button", { name: "Add" }).click();
      await page.getByRole("menu").waitFor();
      // A click on another terminal closes the flyout; that terminal keeps the keyboard.
      await page.locator(`[data-panel="${first}"] .xterm`).click();
      await typeInto(page, first, `add-click-away-${String(round)}`);
      await page.getByRole("menu").waitFor({ state: "detached" });

      await page.locator("header button").first().click();
      await page.getByRole("menu").waitFor();
      await page.keyboard.press("Escape");
      await typeInto(page, first, `workspaces-esc-${String(round)}`);
      await page.getByRole("menu").waitFor({ state: "detached" });

      await page.keyboard.press("Control+Comma");
      await page.getByRole("dialog").waitFor();
      await page.keyboard.press("Escape");
      await typeInto(page, first, `settings-esc-${String(round)}`);
      await page.getByRole("dialog").waitFor({ state: "detached" });
    }

    // A flyout item that opens a panel: the new terminal has the keyboard.
    const before = new Set(await shownPanels(page));
    await page.getByRole("button", { name: "Add" }).click();
    await page.getByRole("menuitem", { name: /^Terminal/ }).click();
    const added = (await waitForPanels(page, 3)).find((p) => !before.has(p)) ?? "";
    await typeInto(page, added, "add-item");

    // An agent works (its spinner turns) in the second tab while the user types in the shell
    // next to it.
    await page.keyboard.press("Control+Tab");
    await waitForTabs(page, 2, 1);
    await waitForFocus(page, third);
    await run(page, `cd /d "${project}"`);
    await waitForScreen(page, third, /project>$/, { joined: true });
    await page.getByRole("button", { name: "Agents" }).click();
    await page.getByRole("menuitem", { name: "Claude Code" }).click();
    const agent = (await waitForPanels(page, 2)).find((p) => p !== third) ?? "";
    await waitForFocus(page, agent);
    await waitForScreen(page, agent, /stub-claude --session-id/, { joined: true });
    await run(page, "work for a while");
    await page
      .locator(`[data-panel="${agent}"] [data-panel-header] [data-activity="working"]`)
      .waitFor();
    for (let round = 1; round <= ROUNDS; round++) {
      await page.locator(`[data-panel="${third}"] .xterm`).click();
      await typeInto(page, third, `spinner-${String(round)}`);
    }

    // Its finish glows on its block (another panel has the keyboard): type while it plays.
    await page
      .locator(`[data-panel="${agent}"] [data-panel-glow][data-glowing]`)
      .waitFor({ timeout: 15_000 });
    await typeInto(page, third, "glow");
    // The keyboard stayed with the shell the user chose.
    if ((await focusedPanel(page)) !== third) throw new Error("the focus left the shell");
    await waitForPrompt(page, third);
    await app.screenshot("n02-typing");
  });
});
