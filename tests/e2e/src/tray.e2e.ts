// N-01 end to end: the window's Close hides WolfCmd to the tray. The process keeps running and so
// does its terminal (a command typed while hidden runs), the one hint about the tray waits under
// the title bar and is remembered in settings.toml, and Ctrl+Q quits for real, saving the
// workspaces. (With `window.close_to_tray` off, Close quits: `app.e2e.ts`' bounds scenario. A
// second launch showing the hidden window needs the single-instance handoff, which debug and
// sandboxed builds leave out.)
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, test } from "vitest";

import { Sandbox, waitFor, windowShown } from "./harness";
import { notices, run, waitForFocus, waitForPanels, waitForPrompt, waitForScreen } from "./ui";

let sandbox: Sandbox | undefined;
afterEach(async ({ task }) => {
  await sandbox?.finish(task);
  sandbox = undefined;
});

describe("N-01 the tray", () => {
  test("N-01 Close hides WolfCmd to the tray: it keeps running, the hint shows once, Ctrl+Q quits", async () => {
    const box = new Sandbox("tray");
    sandbox = box;
    const app = await box.launch();
    const page = app.page;
    await page.getByRole("button", { name: "Open a terminal (Enter)" }).waitFor();
    await page.keyboard.press("Enter");
    const [panel] = await waitForPanels(page, 1);
    if (panel === undefined) throw new Error("no panel");
    await waitForFocus(page, panel);
    await waitForPrompt(page, panel);
    await waitFor("the window on screen", () => windowShown(app.pid));

    await app.hide();
    await waitFor("the window hidden", () => !windowShown(app.pid));
    expect(app.exited).toBe(false);
    // The hint is remembered at once, so it never shows again.
    await waitFor("the hint remembered", () =>
      readFileSync(box.dataFile("settings.toml"), "utf8").includes("tray_hint_shown = true"),
    );
    // It waits under the title bar for the window's return.
    await waitFor("the tray hint", async () =>
      (await notices(page)).some((text) => text.includes("still running in the tray")),
    );

    // The terminal keeps running while hidden.
    await run(page, "echo while-hidden");
    await waitForScreen(page, panel, /^while-hidden$/m);
    expect(windowShown(app.pid)).toBe(false);

    // Ctrl+Q quits for real: the process ends, and the workspace with its terminal is saved.
    await app.quit();
    const saved = box.savedDocument();
    expect(saved.workspaces[0]?.tabs[0]?.layout).not.toBeNull();
  });
});
