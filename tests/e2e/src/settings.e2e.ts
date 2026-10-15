// N-07 end to end: Settings opens with Ctrl+, over a running terminal; Light restyles the window
// and the terminal at once, a bigger font reflows the shell once, Esc closes it (the terminal
// has the keyboard again), and a restart keeps the choices. Screenshots of every section, dark
// and light, are copied to `WOLFCMD_E2E_SETTINGS_SHOTS` when it is set.
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { type RunningApp, Sandbox, sleep, waitFor } from "./harness";
import { shownPanels, waitForFocus, waitForPanels, waitForPrompt } from "./ui";

let sandbox: Sandbox | undefined;
afterEach(async ({ task }) => {
  await sandbox?.finish(task);
  sandbox = undefined;
});

const SHOTS = process.env.WOLFCMD_E2E_SETTINGS_SHOTS;

/** The dialog alone (or the window), saved under screenshots/ and copied to `SHOTS`. */
async function shot(app: RunningApp, name: string, dialogOnly = true): Promise<void> {
  const path = await app.screenshot(name);
  if (dialogOnly) await app.page.locator('[role="dialog"]').screenshot({ path });
  if (SHOTS !== undefined) {
    mkdirSync(SHOTS, { recursive: true });
    copyFileSync(path, join(SHOTS, `${name}.png`));
  }
}

/** Every animation has ended (the dialog's entrance), for a screenshot. */
const settled = (app: RunningApp) =>
  app.page.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState !== "running"),
  );

/** Scrolls the dialog to a section, then shoots it. */
async function shootSections(app: RunningApp, look: string) {
  await settled(app);
  for (const section of ["Appearance", "Terminal", "Agents", "About"]) {
    // Each section from its header down (the last one: the end of the list).
    await app.page.getByRole("heading", { name: section }).evaluate((heading) => {
      heading.scrollIntoView({ block: "start" });
    });
    await settled(app);
    await shot(app, `settings-${look}-${section.toLowerCase()}`);
  }
}

async function openTerminal(app: RunningApp): Promise<string> {
  await app.page.getByRole("button", { name: "Open a terminal (Enter)" }).waitFor();
  await app.page.keyboard.press("Enter");
  const [panel] = await waitForPanels(app.page, 1);
  if (panel === undefined) throw new Error("no panel");
  await waitForFocus(app.page, panel);
  await waitForPrompt(app.page, panel);
  return panel;
}

/** The terminal as drawn: its box's background, xterm's text color (its theme) and font size. */
async function terminalLook(app: RunningApp, panel: string) {
  return app.page.evaluate((id) => {
    const term = document.querySelector(`[data-panel="${id}"] .xterm`);
    const rows = document.querySelector(`[data-panel="${id}"] .xterm-rows`);
    const box = term?.closest(".bg-term-bg");
    return {
      background: box == null ? "" : getComputedStyle(box).backgroundColor,
      text: rows === null ? "" : getComputedStyle(rows).color,
      fontSize: rows === null ? "" : getComputedStyle(rows).fontSize,
    };
  }, panel);
}

const theme = (app: RunningApp) =>
  app.page.evaluate(() => document.documentElement.dataset.theme ?? "");

const dialog = (app: RunningApp) => app.page.getByRole("dialog", { name: "Settings" });
const segment = (app: RunningApp, label: string) =>
  dialog(app).locator("label.wc-segment", { hasText: new RegExp(`^${label}$`) });

describe("N-07 Settings", () => {
  test("N-07 Ctrl+, Light, a bigger font, Esc, and a restart keeps them", async () => {
    const box = (sandbox = new Sandbox("settings"));
    let app = await box.launch();
    const panel = await openTerminal(app);
    const before = await terminalLook(app, panel);
    expect(await theme(app)).toBe("dark");

    // Opens with Ctrl+, over the terminal; the chosen theme has the focus.
    await app.page.keyboard.press("Control+Comma");
    await dialog(app).waitFor();
    await settled(app);
    expect(await app.page.evaluate(() => (document.activeElement as HTMLInputElement).value)).toBe(
      "dark",
    );
    await shot(app, "settings-dark-window", false);
    await shootSections(app, "dark");
    await app.page.getByRole("heading", { name: "Appearance" }).scrollIntoViewIfNeeded();

    // Light: the tokens and the terminal follow at once.
    await segment(app, "Light").click();
    await waitFor("the light theme", async () => (await theme(app)) === "light");
    await waitFor("the terminal's light background and text", async () => {
      const now = await terminalLook(app, panel);
      return now.background !== before.background && now.text !== before.text;
    });
    await settled(app);
    await shot(app, "settings-light-window", false);
    await shootSections(app, "light");
    await app.page.getByRole("heading", { name: "Appearance" }).scrollIntoViewIfNeeded();

    // One step bigger: the terminal redraws at 15 px and the shell reflows once.
    await app.page.evaluate(() => {
      const probe = { resizes: 0 };
      (window as unknown as { __wcResizes: typeof probe }).__wcResizes = probe;
      const fetchIpc = window.fetch.bind(window);
      window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("ipc.localhost/pty_resize")) probe.resizes += 1;
        return fetchIpc(input, init);
      };
    });
    expect(before.fontSize).toBe("14px");
    await dialog(app).getByRole("button", { name: "Larger" }).click();
    await waitFor(
      "the 15 px font",
      async () => (await terminalLook(app, panel)).fontSize === "15px",
    );
    const resizes = () =>
      app.page.evaluate(
        () => (window as unknown as { __wcResizes: { resizes: number } }).__wcResizes.resizes,
      );
    await waitFor("the shell's reflow", async () => (await resizes()) >= 1);
    await sleep(800);
    expect(await resizes()).toBe(1);

    // Esc closes it; the terminal has the keyboard again.
    await app.page.keyboard.press("Escape");
    await dialog(app).waitFor({ state: "detached" });
    expect(
      await app.page.evaluate((id) => {
        const active = document.activeElement;
        return (
          active?.classList.contains("xterm-helper-textarea") === true &&
          active.closest(`[data-panel="${id}"]`) !== null
        );
      }, panel),
    ).toBe(true);
    const saved = readFileSync(box.dataFile("settings.toml"), "utf8");
    expect(saved).toMatch(/theme = "light"/);
    expect(saved).toMatch(/font_size = 15/);

    // A restart keeps them.
    await app.quit();
    app = await box.launch();
    expect(await theme(app)).toBe("light");
    const [restored] = await waitForPanels(app.page, 1);
    if (restored === undefined) throw new Error("no restored panel");
    await waitFor(
      "the restored terminal at 15 px",
      async () => (await terminalLook(app, restored)).fontSize === "15px",
    );
    expect(await shownPanels(app.page)).toEqual([restored]);
    await app.page.keyboard.press("Control+Comma");
    await dialog(app).waitFor();
    expect(await dialog(app).getByRole("radio", { name: "Light" }).isChecked()).toBe(true);
    expect(await dialog(app).getByRole("spinbutton").inputValue()).toBe("15");
    await dialog(app).getByRole("button", { name: "Close" }).click();
    await dialog(app).waitFor({ state: "detached" });
  });
});
