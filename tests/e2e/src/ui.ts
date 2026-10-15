// Driving the WolfCmd UI like a user, and reading what it shows. Panels are found by their
// `data-panel` ID (`data-focused` on the one with the keyboard); a terminal's screen is read from
// xterm's DOM renderer rows (the harness turns WebGL off).
import type { Page } from "playwright-core";

import { waitFor } from "./harness";

/** The panels of the shown tab, in document order. */
export async function shownPanels(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[data-panel]")]
      .filter((card) => !card.classList.contains("invisible"))
      .map((card) => card.dataset.panel ?? ""),
  );
}

export async function focusedPanel(page: Page): Promise<string | undefined> {
  return page.evaluate(
    () => document.querySelector<HTMLElement>("[data-panel][data-focused]")?.dataset.panel,
  );
}

/** Waits until the shown tab has `count` panels; returns them. */
export async function waitForPanels(page: Page, count: number): Promise<string[]> {
  return waitFor(`${String(count)} panels`, async () => {
    const panels = await shownPanels(page);
    return panels.length === count ? panels : undefined;
  });
}

export async function waitForFocus(page: Page, panel: string): Promise<void> {
  await waitFor(`focus on ${panel}`, async () => (await focusedPanel(page)) === panel);
}

/** A panel's box on the page. */
export async function panelBox(page: Page, panel: string) {
  // N-01: where the panel settles, once its own motion (appearing, growing from its tile) ended.
  await page.waitForFunction(
    (id) =>
      document
        .querySelector(`[data-panel="${id}"]`)
        ?.getAnimations()
        .every((animation) => animation.playState !== "running") ?? true,
    panel,
  );
  const box = await page.locator(`[data-panel="${panel}"]`).boundingBox();
  if (box === null) throw new Error(`panel ${panel} is not on screen`);
  return box;
}

/** The text a panel's terminal shows now (its visible rows). */
export async function screen(page: Page, panel: string): Promise<string> {
  return page.evaluate(
    (id) =>
      [...document.querySelectorAll(`[data-panel="${id}"] .xterm-rows > div`)]
        .map((row) => row.textContent.replaceAll("\u00a0", " ").trimEnd())
        .join("\n"),
    panel,
  );
}

/**
 * The rows run together, so a line the terminal wrapped (a deep folder in a narrow panel) reads
 * as one. Only for checks that don't care where rows end.
 */
export const flat = (text: string) => text.replaceAll("\n", "");

export interface ScreenWait {
  readonly timeout?: number;
  /** Match against the rows run together (`flat`). */
  readonly joined?: boolean;
}

/** Waits until the panel's screen matches; the error shows the screen. */
export async function waitForScreen(
  page: Page,
  panel: string,
  pattern: RegExp,
  { timeout = 20_000, joined = false }: ScreenWait = {},
): Promise<string> {
  let last = "";
  try {
    return await waitFor(
      `${String(pattern)} in panel ${panel}`,
      async () => {
        last = await screen(page, panel);
        return pattern.test(joined ? flat(last) : last) ? last : undefined;
      },
      timeout,
    );
  } catch (error) {
    throw new Error(`${String(error)}\n--- screen ---\n${last}\n---`, { cause: error });
  }
}

/** A Command Prompt prompt (`C:\some\folder>`, maybe wrapped) at the end of the screen. */
const PROMPT = /[A-Za-z]:\\[^>]*>\s*$/;

export async function waitForPrompt(page: Page, panel: string): Promise<string> {
  return waitForScreen(page, panel, PROMPT, { timeout: 30_000, joined: true });
}

/** Types a command into the focused terminal and presses Enter. */
export async function run(page: Page, command: string): Promise<void> {
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

/** How many rows show exactly `line`. */
export function countLines(text: string, line: string): number {
  return text.split("\n").filter((row) => row.trim() === line).length;
}

/** The shown tab's name and the names of all tabs. */
export async function tabState(page: Page): Promise<{ names: string[]; selected: number }> {
  return page.evaluate(() => {
    const all = [...document.querySelectorAll("header [role=tab]")];
    return {
      // The name's span (the close button's icon is text too).
      names: all.map((tab) => tab.querySelector("span")?.textContent.trim() ?? ""),
      selected: all.findIndex((tab) => tab.getAttribute("aria-selected") === "true"),
    };
  });
}

export async function waitForTabs(page: Page, count: number, selected: number): Promise<void> {
  await waitFor(`${String(count)} tabs, number ${String(selected + 1)} shown`, async () => {
    const state = await tabState(page);
    return state.names.length === count && state.selected === selected;
  });
}

/** The workspace switcher (the name at the top left). */
const workspaceButton = (page: Page) => page.locator("header button").first();

export async function workspaceName(page: Page): Promise<string> {
  return (await workspaceButton(page).locator("span").first().innerText()).trim();
}

/** Opens the workspace menu and returns the workspace names it lists. */
export async function openWorkspaceMenu(page: Page): Promise<string[]> {
  // A click while the last menu is still fading out (100 ms) only finishes closing it.
  await page.getByRole("menu").waitFor({ state: "detached" });
  await workspaceButton(page).click();
  const items = page.getByRole("menuitemradio");
  await items.first().waitFor();
  return (await items.allInnerTexts()).map((text) => text.trim());
}

/** The calm notices under the title bar. */
export async function notices(page: Page): Promise<string[]> {
  return (await page.getByRole("status").allInnerTexts()).map((text) => text.trim());
}
