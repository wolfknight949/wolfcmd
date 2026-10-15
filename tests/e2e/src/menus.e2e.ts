// N-03 end to end: context menus (tab pills, panel headers, terminals, workspace rows; mouse and
// Shift+F10) and maximizing a panel (its shell and the hidden one keep running; a restart keeps
// it). One fresh data folder per scenario; screenshots under tests/e2e/screenshots/.
import { afterEach, describe, expect, test } from "vitest";

import { type RunningApp, Sandbox, savedPanels, waitFor } from "./harness";
import {
  openWorkspaceMenu,
  panelBox,
  run,
  screen,
  shownPanels,
  waitForFocus,
  waitForPanels,
  waitForPrompt,
  waitForScreen,
  waitForTabs,
  workspaceName,
} from "./ui";

let sandbox: Sandbox | undefined;
const fresh = (name: string) => (sandbox = new Sandbox(name));
afterEach(async ({ task }) => {
  await sandbox?.finish(task);
  sandbox = undefined;
});

const emptyTabButton = (app: RunningApp) =>
  app.page.getByRole("button", { name: "Open a terminal (Enter)" });

/** Enter on an empty tab: a new terminal at its first prompt. */
async function openTerminal(app: RunningApp, count = 1): Promise<string> {
  const before = new Set(await shownPanels(app.page));
  await emptyTabButton(app).waitFor();
  await app.page.keyboard.press("Enter");
  const panels = await waitForPanels(app.page, count);
  const panel = panels.find((id) => !before.has(id));
  if (panel === undefined) throw new Error("no new panel");
  await waitForFocus(app.page, panel);
  await waitForPrompt(app.page, panel);
  return panel;
}

/** Split right of the focused panel, at its prompt. */
async function splitRight(app: RunningApp, count: number): Promise<string> {
  const before = new Set(await shownPanels(app.page));
  await app.page.keyboard.press("Alt+Shift+Equal");
  const panels = await waitForPanels(app.page, count);
  const panel = panels.find((id) => !before.has(id));
  if (panel === undefined) throw new Error("no new panel");
  await waitForFocus(app.page, panel);
  await waitForPrompt(app.page, panel);
  return panel;
}

const menu = (app: RunningApp, name: string) => app.page.getByRole("menu", { name });

/** Every animation has ended (a menu faded in), for a screenshot. */
const settled = (app: RunningApp) =>
  app.page.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState !== "running"),
  );

/** The menu is gone (also after its 100 ms fade-out). */
const closed = (app: RunningApp) => app.page.getByRole("menu").waitFor({ state: "detached" });

describe("N-03 maximize and context menus", () => {
  test("N-03 maximize then restore keeps both shells; the maximize survives a restart", async () => {
    const box = fresh("maximize");
    let app = await box.launch();
    let { page } = app;
    const a = await openTerminal(app);
    await run(page, "echo marker-a");
    await waitForScreen(page, a, /^marker-a$/m);
    const b = await splitRight(app, 2);
    await run(page, "echo marker-b");
    await waitForScreen(page, b, /^marker-b$/m);
    const area = await panelBox(page, a);

    // Ctrl+Shift+Enter: B fills the tab, A is hidden but keeps its shell and its text.
    await page.keyboard.press("Control+Shift+Enter");
    await waitForPanels(page, 1);
    expect(await shownPanels(page)).toEqual([b]);
    const filled = await panelBox(page, b);
    expect(filled.x).toBeLessThan(area.x + 2);
    await page.getByRole("button", { name: /^Restore/ }).waitFor();
    expect(await page.locator('header [aria-label="A panel is maximized"]').count()).toBe(1);
    await run(page, "echo while-maximized");
    await waitForScreen(page, b, /^while-maximized$/m);
    expect(await screen(page, a)).toMatch(/^marker-a$/m);
    await app.screenshot("n03-maximized");

    // Restore (the header's button): both again, A's shell still answers.
    await page.getByRole("button", { name: /^Restore/ }).click();
    await waitForPanels(page, 2);
    expect(await page.locator('header [aria-label="A panel is maximized"]').count()).toBe(0);
    await page.keyboard.press("Alt+ArrowLeft");
    await waitForFocus(page, a);
    await run(page, "echo after-restore");
    await waitForScreen(page, a, /^after-restore$/m);
    expect(await screen(page, a)).toMatch(/^marker-a$/m);
    await waitForScreen(page, b, /^while-maximized$/m);

    // A double-click on B's header maximizes it again, and that is saved.
    await page.locator(`[data-panel="${b}"] [data-panel-header] span[title]`).first().dblclick();
    await waitForPanels(page, 1);
    await waitFor(
      "the saved maximize",
      () => box.savedDocument().workspaces[0]?.tabs[0]?.maximized === b,
    );

    await app.quit();
    app = await box.launch();
    page = app.page;
    expect(await waitForPanels(page, 1)).toEqual([b]);
    await waitForScreen(page, b, /while-maximized/);
    await page.keyboard.press("Control+Shift+Enter");
    expect((await waitForPanels(page, 2)).sort()).toEqual([a, b].sort());
    expect(savedPanels(box.savedDocument().workspaces[0]?.tabs[0]?.layout ?? null)).toHaveLength(2);
  });

  test("N-02 command marks in a maximized panel sit slim on the scrollbar track at its edge", async () => {
    const app = await fresh("ruler").launch();
    const { page } = app;
    await openTerminal(app);
    const b = await splitRight(app, 2);
    for (const word of ["one", "two", "three"]) {
      await run(page, `echo ${word}`);
      await waitForScreen(page, b, new RegExp(`^${word}$`, "m"));
    }
    await page.keyboard.press("Control+Shift+Enter");
    await waitForPanels(page, 1);
    const ruler = await waitFor("the marks on the ruler", () =>
      page.evaluate((id) => {
        const card = document.querySelector<HTMLElement>(`[data-panel="${id}"]`);
        const canvas = card?.querySelector<HTMLCanvasElement>(".xterm-decoration-overview-ruler");
        const track = card?.querySelector<HTMLElement>(".xterm-scrollable-element > .vertical");
        const context = canvas?.getContext("2d");
        if (!card || !canvas || !track || !context) return undefined;
        // The painted runs of rows in the track's last column, top to bottom: each mark is one
        // run (a mark across the whole track reaches it; column 0 is xterm's border line).
        const { data } = context.getImageData(canvas.width - 1, 0, 1, canvas.height);
        const runs: number[] = [];
        let length = 0;
        for (let y = 0; y < canvas.height; y++) {
          const painted = (data[y * 4 + 3] ?? 0) > 0;
          if (painted) {
            length += 1;
          } else if (length > 0) {
            runs.push(length);
            length = 0;
          }
        }
        if (runs.length < 3) return undefined;
        const box = canvas.getBoundingClientRect();
        return {
          runs,
          dpr: window.devicePixelRatio,
          rulerLeft: box.left,
          rulerRight: box.right,
          trackLeft: track.getBoundingClientRect().left,
          cardRight: card.getBoundingClientRect().right,
          border: parseFloat(getComputedStyle(card).borderRightWidth),
        };
      }, b),
    );
    await app.screenshot("n02-ruler");
    // On the track, at the card's edge (inside its border), not floating beside the text.
    expect(Math.abs(ruler.rulerLeft - ruler.trackLeft)).toBeLessThan(1);
    expect(ruler.cardRight - ruler.border - ruler.rulerRight).toBeLessThan(1);
    // Slim lines (xterm's `full` lane: 2 CSS px), not 6 to 12 px bars.
    for (const height of ruler.runs) expect(height).toBeLessThanOrEqual(Math.ceil(2 * ruler.dpr));
  });

  test("N-03 context menus: a pill's Close others, Shift+F10 in a panel, a header, a workspace row", async () => {
    const app = await fresh("menus").launch();
    const { page } = app;
    await openTerminal(app);
    await page.keyboard.press("Control+Shift+T");
    await page.keyboard.press("Control+Shift+T");
    await waitForTabs(page, 3, 2);

    // A pill's menu: Close others leaves that one tab.
    await page.locator("header [role=tab]").nth(1).click({ button: "right" });
    await menu(app, "Tab actions").waitFor();
    await settled(app);
    await app.screenshot("n03-menu-tab");
    await page.getByRole("menuitem", { name: "Close others" }).click();
    await waitForTabs(page, 1, 0);
    await closed(app);

    // Shift+F10 in the focused terminal: its menu (the clipboard, find, the layout).
    const p = await openTerminal(app);
    const q = await splitRight(app, 2);
    await page.keyboard.press("Shift+F10");
    await menu(app, "Terminal actions").waitFor();
    expect(await page.getByRole("menuitem", { name: /^Copy/ }).isDisabled()).toBe(true);
    await settled(app);
    await app.screenshot("n03-menu-terminal");
    // Esc gives the keyboard back to the shell.
    await page.keyboard.press("Escape");
    await closed(app);
    await run(page, "echo after-menu");
    await waitForScreen(page, q, /^after-menu$/m);
    // Its Maximize fills the tab.
    await page.keyboard.press("Shift+F10");
    await page.getByRole("menuitem", { name: /^Maximize/ }).click();
    expect(await waitForPanels(page, 1)).toEqual([q]);
    await page.keyboard.press("Control+Shift+Enter");
    await waitForPanels(page, 2);
    await closed(app);

    // A header's menu (right-click): Split, Maximize, Rename, Close.
    const header = page.locator(`[data-panel="${p}"] [data-panel-header]`);
    await header.click({ button: "right", position: { x: 40, y: 10 } });
    await menu(app, "Panel actions").waitFor();
    await settled(app);
    await app.screenshot("n03-menu-panel-header");
    await page.getByRole("menuitem", { name: "Rename" }).click();
    const field = page.getByRole("textbox", { name: "Panel name" });
    await field.fill("Server");
    await field.press("Enter");
    await waitFor("the renamed panel", async () => (await header.innerText()).includes("Server"));

    // A workspace row's menu, over the switcher: Rename… opens a dialog.
    expect(await openWorkspaceMenu(page)).toEqual(["Workspace 1"]);
    await page.getByRole("menuitemradio", { name: "Workspace 1" }).click({ button: "right" });
    await menu(app, "Actions for Workspace 1").waitFor();
    await settled(app);
    await app.screenshot("n03-menu-workspace");
    await page.getByRole("menuitem", { name: "Rename…" }).click();
    const name = page.getByRole("textbox", { name: "Name" });
    await name.fill("Renamed");
    await name.press("Enter");
    await waitFor("the renamed workspace", async () => (await workspaceName(page)) === "Renamed");
  });
});
