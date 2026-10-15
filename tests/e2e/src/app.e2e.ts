// N-02 … N-06 end to end: the real WolfCmd.exe, driven like a user (keys and clicks), one fresh
// data folder per scenario. Each scenario saves a screenshot under tests/e2e/screenshots/.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  placeWindow,
  type RunningApp,
  Sandbox,
  savedPanels,
  sleep,
  waitFor,
  windowRect,
  writeText,
} from "./harness";
import {
  countLines,
  flat,
  focusedPanel,
  notices,
  openWorkspaceMenu,
  panelBox,
  run,
  screen,
  shownPanels,
  tabState,
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

/** Enter on an empty tab: a new terminal, at its first prompt. Returns its panel. */
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

/** A split of the focused panel (Alt+Shift+= right, Alt+Shift+- down), at its prompt. */
async function split(app: RunningApp, key: "Equal" | "Minus", count: number): Promise<string> {
  const before = new Set(await shownPanels(app.page));
  await app.page.keyboard.press(`Alt+Shift+${key}`);
  const panels = await waitForPanels(app.page, count);
  const panel = panels.find((id) => !before.has(id));
  if (panel === undefined) throw new Error("no new panel");
  await waitForFocus(app.page, panel);
  await waitForPrompt(app.page, panel);
  return panel;
}

const emptyTabButton = (app: RunningApp) =>
  app.page.getByRole("button", { name: "Open a terminal (Enter)" });

const sameFolder = (a: string | null | undefined, b: string) =>
  (a ?? "").replace(/\\$/, "").toLowerCase() === b.replace(/\\$/, "").toLowerCase();

describe("WolfCmd end to end", () => {
  test("N-03 the window opens with an empty tab, and Enter opens a terminal", async () => {
    const app = await fresh("empty").launch();
    await emptyTabButton(app).waitFor();
    expect(await tabState(app.page)).toEqual({ names: ["Tab 1"], selected: 0 });
    expect(await shownPanels(app.page)).toEqual([]);
    const panel = await openTerminal(app);
    expect(await emptyTabButton(app).count()).toBe(0);
    expect(await screen(app.page, panel)).toMatch(/Microsoft Windows/);
    await app.screenshot("01-empty-tab-enter-opens-terminal");
  });

  test("N-02 typing echo hello shows hello", async () => {
    const app = await fresh("echo").launch();
    const panel = await openTerminal(app);
    await run(app.page, "echo hello");
    const text = await waitForScreen(app.page, panel, /^hello$/m);
    expect(text).toMatch(/>echo hello$/m);
    await waitForScreen(app.page, panel, /^hello\n\n[A-Za-z]:\\[^\n]*>$/m);
    await app.screenshot("02-echo-hello");
  });

  test("N-03 split right and down, Alt+arrows move the focus, Ctrl+Shift+W closes", async () => {
    const app = await fresh("splits").launch();
    const { page } = app;
    const a = await openTerminal(app);
    const b = await split(app, "Equal", 2);
    const c = await split(app, "Minus", 3);
    const [boxA, boxB, boxC] = [
      await panelBox(page, a),
      await panelBox(page, b),
      await panelBox(page, c),
    ];
    expect(boxB.x).toBeGreaterThan(boxA.x + boxA.width / 2); // B right of A
    expect(boxC.y).toBeGreaterThan(boxB.y + boxB.height / 2); // C under B
    expect(Math.abs(boxC.x - boxB.x)).toBeLessThan(2);

    await page.keyboard.press("Alt+ArrowUp");
    await waitForFocus(page, b);
    await page.keyboard.press("Alt+ArrowDown");
    await waitForFocus(page, c);
    await page.keyboard.press("Alt+ArrowLeft");
    await waitForFocus(page, a);
    // The keyboard follows the focus: only A runs this.
    await run(page, "echo typed-in-a");
    await waitForScreen(page, a, /^typed-in-a$/m);
    expect(await screen(page, b)).not.toMatch(/typed-in-a/);
    expect(await screen(page, c)).not.toMatch(/typed-in-a/);
    await page.keyboard.press("Alt+ArrowRight");
    await waitFor("focus right of A", async () => {
      const focused = await focusedPanel(page);
      return focused === b || focused === c;
    });
    await app.screenshot("03-splits-focus");

    await page.keyboard.press("Alt+ArrowLeft");
    await waitForFocus(page, a);
    await page.keyboard.press("Control+Shift+W");
    expect((await waitForPanels(page, 2)).sort()).toEqual([b, c].sort());
    const [left] = await Promise.all([panelBox(page, b)]);
    expect(left.x).toBeLessThan(20); // B and C took A's room
    await waitFor("a focused panel", async () => (await focusedPanel(page)) !== undefined);
    await page.keyboard.press("Control+Shift+W");
    await waitForPanels(page, 1);
    await waitFor("a focused panel", async () => (await focusedPanel(page)) !== undefined);
    await page.keyboard.press("Control+Shift+W");
    await waitForPanels(page, 0);
    await emptyTabButton(app).waitFor();
  });

  test("N-03 new tab, switch with Ctrl+Tab and Ctrl+Alt+2, rename by double-click", async () => {
    const box = fresh("tabs");
    const app = await box.launch();
    const { page } = app;
    const first = await openTerminal(app);
    await run(page, "echo in-tab-one");
    await waitForScreen(page, first, /^in-tab-one$/m);

    await page.keyboard.press("Control+Shift+T");
    await waitForTabs(page, 2, 1);
    // The hidden terminal gave the keyboard up: the empty tab's Enter never reaches its shell.
    expect(
      await page.evaluate(
        () => document.activeElement?.closest<HTMLElement>("[data-panel]")?.dataset.panel,
      ),
    ).toBeUndefined();
    await emptyTabButton(app).waitFor();
    expect(await shownPanels(page)).toEqual([]);
    await page.keyboard.press("Control+Shift+T");
    await waitForTabs(page, 3, 2);

    await page.keyboard.press("Control+Tab"); // wraps around to the first
    await waitForTabs(page, 3, 0);
    expect(await shownPanels(page)).toEqual([first]);
    // The hidden tab's terminal kept running and kept its output.
    await waitForScreen(page, first, /^in-tab-one$/m);
    await page.keyboard.press("Control+Alt+Digit2");
    await waitForTabs(page, 3, 1);
    await page.keyboard.press("Control+Shift+Tab");
    await waitForTabs(page, 3, 0);

    await page.locator("header [role=tab]").nth(2).dblclick();
    const input = page.locator("header input");
    await input.waitFor();
    await input.fill("Build");
    await input.press("Enter");
    await waitFor("the renamed tab", async () => {
      const state = await tabState(page);
      return state.names.join("|") === "Tab 1|Tab 2|Build" && state.selected === 2;
    });
    await waitFor(
      "the saved name",
      () => box.savedDocument().workspaces[0]?.tabs[2]?.name === "Build",
    );
    await app.screenshot("04-tabs");
  });

  test("N-04 new workspace with Ctrl+Shift+N, switching through the workspace menu", async () => {
    const app = await fresh("workspaces").launch();
    const { page } = app;
    expect(await workspaceName(page)).toBe("Workspace 1");
    const one = await openTerminal(app);
    await run(page, "echo in-workspace-one");
    await waitForScreen(page, one, /^in-workspace-one$/m);

    await page.keyboard.press("Control+Shift+N");
    await waitFor("Workspace 2", async () => (await workspaceName(page)) === "Workspace 2");
    await emptyTabButton(app).waitFor();
    expect(await tabState(page)).toEqual({ names: ["Tab 1"], selected: 0 });
    const two = await openTerminal(app);
    await run(page, "echo in-workspace-two");
    await waitForScreen(page, two, /^in-workspace-two$/m);

    expect(await openWorkspaceMenu(page)).toEqual(["Workspace 1", "Workspace 2"]);
    await app.screenshot("05-workspace-menu");
    await page.getByRole("menuitemradio", { name: "Workspace 1" }).click();
    await waitFor("Workspace 1", async () => (await workspaceName(page)) === "Workspace 1");
    expect(await shownPanels(page)).toEqual([one]);
    await waitForScreen(page, one, /^in-workspace-one$/m);

    await openWorkspaceMenu(page);
    await page.getByRole("menuitemradio", { name: "Workspace 2" }).click();
    await waitFor("Workspace 2", async () => (await workspaceName(page)) === "Workspace 2");
    expect(await shownPanels(page)).toEqual([two]);
    await waitForScreen(page, two, /^in-workspace-two$/m);
  });

  test("N-02 a page reload keeps the shells: no lost state, no duplicated output", async () => {
    const app = await fresh("reload").launch();
    const { page } = app;
    const panel = await openTerminal(app);
    await run(page, "set X=42");
    await run(page, "echo once%X%");
    await waitForScreen(page, panel, /^once42$/m);

    await Promise.all([
      page.waitForEvent("load"),
      page.evaluate(() => {
        setTimeout(() => {
          location.reload();
        }, 0);
      }),
    ]);
    expect(await waitForPanels(page, 1)).toEqual([panel]);
    const replayed = await waitForScreen(page, panel, /^once42$/m);
    expect(countLines(replayed, "once42")).toBe(1);
    expect(replayed.match(/Microsoft Windows \[Version/g)?.length).toBe(1);

    await waitForFocus(page, panel);
    await run(page, "echo after%X%");
    const after = await waitForScreen(page, panel, /^after42$/m);
    expect(countLines(after, "once42")).toBe(1);
    expect(countLines(after, "after42")).toBe(1);
    await app.screenshot("06-reload-keeps-shells");
  });

  test("N-05 a hard kill, then a relaunch, restores workspaces, tabs, splits, folders and scrollback", async () => {
    const box = fresh("restore");
    const project = box.folder("project");
    let app = await box.launch();
    let { page } = app;
    const a = await openTerminal(app);
    await run(page, `cd /d "${project}"`);
    await waitForScreen(page, a, /project>$/, { joined: true });
    await run(page, "echo marker-a");
    await waitForScreen(page, a, /^marker-a$/m);
    const b = await split(app, "Equal", 2);
    await run(page, "echo marker-b");
    await waitForScreen(page, b, /^marker-b$/m);
    await page.keyboard.press("Control+Shift+T");
    await waitForTabs(page, 2, 1);
    const c = await openTerminal(app);
    await run(page, "echo marker-c");
    await waitForScreen(page, c, /^marker-c$/m);
    await page.locator("header [role=tab]").nth(1).dblclick();
    await page.locator("header input").fill("Second");
    await page.locator("header input").press("Enter");
    await page.keyboard.press("Control+Shift+N");
    await waitFor("Workspace 2", async () => (await workspaceName(page)) === "Workspace 2");
    const d = await openTerminal(app);
    await run(page, "echo marker-d");
    await waitForScreen(page, d, /^marker-d$/m);

    // Saved at once: the layout, and A's folder from the shell (cmd's prompt reports it).
    const saved = await waitFor("the saved layout", () => {
      const doc = box.savedDocument();
      const [w1, w2] = doc.workspaces;
      const panels = savedPanels(w1?.tabs[0]?.layout ?? null);
      const ready =
        doc.workspaces.length === 2 &&
        panels.map((p) => p.id).join() === [a, b].join() &&
        sameFolder(panels[0]?.content.cwd, project) &&
        w1?.tabs[1]?.name === "Second" &&
        savedPanels(w2?.tabs[0]?.layout ?? null)[0]?.id === d;
      return ready ? doc : undefined;
    });
    expect(saved.active).toBe(saved.workspaces[1]?.id);
    // Scrollback is saved once a terminal goes quiet (5 s).
    await waitFor(
      "the scrollback snapshots",
      () => [a, b, c, d].every((p) => existsSync(box.dataFile(`scrollback/${p}.snap`))),
      30_000,
    );

    await app.kill();
    app = await box.launch();
    page = app.page;

    expect(await workspaceName(page)).toBe("Workspace 2");
    expect(await waitForPanels(page, 1)).toEqual([d]);
    await waitForScreen(page, d, /^marker-d$/m);
    expect(await openWorkspaceMenu(page)).toEqual(["Workspace 1", "Workspace 2"]);
    await page.getByRole("menuitemradio", { name: "Workspace 1" }).click();
    await waitFor("Workspace 1", async () => (await workspaceName(page)) === "Workspace 1");
    await waitForTabs(page, 2, 1);
    expect((await tabState(page)).names).toEqual(["Tab 1", "Second"]);
    expect(await waitForPanels(page, 1)).toEqual([c]);
    await waitForScreen(page, c, /^marker-c$/m);
    await page.keyboard.press("Control+Alt+Digit1");
    await waitForTabs(page, 2, 0);
    expect(await waitForPanels(page, 2)).toEqual([a, b]);
    const [boxA, boxB] = await Promise.all([panelBox(page, a), panelBox(page, b)]);
    expect(boxB.x).toBeGreaterThan(boxA.x + boxA.width / 2);
    // The saved scrollback (dim, above a divider), then a new shell in the saved folder.
    await waitForScreen(page, a, /marker-a.*Microsoft Windows.*project>$/, {
      timeout: 30_000,
      joined: true,
    });
    await waitForScreen(page, b, /^marker-b$/m);
    // The keyboard reaches the restored shell.
    await page.locator(`[data-panel="${a}"] .xterm-screen`).click();
    await waitForFocus(page, a);
    await run(page, "echo typed-after-restore");
    await waitForScreen(page, a, /^typed-after-restore$/m);
    await app.screenshot("07-hard-kill-restore");
  });

  test("N-05 a damaged workspaces.json is kept aside and the last good backup opens", async () => {
    const box = fresh("damaged");
    let app = await box.launch();
    await app.page.locator("header [role=tab]").first().dblclick();
    await app.page.locator("header input").fill("Kept");
    await app.page.locator("header input").press("Enter");
    await waitFor(
      "the saved name",
      () => box.savedDocument().workspaces[0]?.tabs[0]?.name === "Kept",
    );
    await app.quit();
    // The next start copies the good file to workspaces.json.bak.
    app = await box.launch();
    await waitFor("the backup", () =>
      readFileSync(box.dataFile("workspaces.json.bak"), "utf8").includes("Kept"),
    );
    await app.quit();

    const damaged = '{"version":1,"workspaces":[{"id":"w1","tabs":[';
    writeText(box.dataFile("workspaces.json"), damaged);
    app = await box.launch();
    const shown = await waitFor("the notice", async () => {
      const all = await notices(app.page);
      return all.length > 0 ? all : undefined;
    });
    expect(shown.join("\n")).toMatch(
      /workspaces\.json was damaged\. It was kept as workspaces\.broken-\d+\.json, and the backup workspaces\.json\.bak was opened\./,
    );
    expect((await tabState(app.page)).names).toEqual(["Kept"]);
    const copies = readdirSync(box.dataDir).filter((f) => f.startsWith("workspaces.broken-"));
    expect(copies).toHaveLength(1);
    expect(readFileSync(join(box.dataDir, copies[0] ?? ""), "utf8")).toBe(damaged);
    await app.screenshot("08-damaged-file-backup-opens");
  });

  test("N-05 a workspaces.json from a newer WolfCmd opens read-only and stays untouched", async () => {
    const box = fresh("newer");
    const future = JSON.stringify({
      version: 99,
      workspaces: [
        {
          id: "w1",
          name: "Future",
          folder: null,
          tabs: [{ id: "t1", name: "From the future", layout: null, focused: null }],
          activeTab: "t1",
          somethingNew: true,
        },
      ],
      active: "w1",
    });
    const file = box.dataFile("workspaces.json");
    writeText(file, future);
    const app = await box.launch();
    const shown = await waitFor("the notice", async () => {
      const all = await notices(app.page);
      return all.length > 0 ? all : undefined;
    });
    expect(shown.join("\n")).toMatch(
      /saved by a newer WolfCmd \(format 99\)\. Changes in this window aren't saved/,
    );
    expect(await workspaceName(app.page)).toBe("Future");
    expect((await tabState(app.page)).names).toEqual(["From the future"]);
    const before = statSync(file).mtimeMs;
    await app.page.keyboard.press("Control+Shift+T");
    await waitForTabs(app.page, 2, 1);
    await openTerminal(app);
    await app.screenshot("09-newer-file-read-only");
    await sleep(1_000);
    await app.quit();
    expect(readFileSync(file, "utf8")).toBe(future);
    expect(statSync(file).mtimeMs).toBe(before);
  });

  test("N-03 a format 1 workspaces.json opens with its panels and shells, backed up and saved as format 2", async () => {
    const box = fresh("v1-file");
    const project = box.folder("project");
    const other = box.folder("other");
    const session = "3f2a1c9e-0b1d-4f6a-8c2e-9a7b5d4c3e21";
    // As WolfCmd 0.1 wrote it: panels with their terminal fields at the top. The agent had ended
    // (`running: false`), so its panel is a plain shell: no agent starts.
    const v1 = JSON.stringify(
      {
        version: 1,
        workspaces: [
          {
            id: "w1",
            name: "Old",
            folder: project,
            tabs: [
              {
                id: "t1",
                name: "Work",
                layout: {
                  kind: "split",
                  id: "s1",
                  direction: "row",
                  ratios: [0.3, 0.7],
                  children: [
                    { kind: "panel", id: "p-build", title: "Build", profile: "cmd", cwd: project },
                    {
                      kind: "panel",
                      id: "p-agent",
                      cwd: other,
                      agent: { agent: "claude-code", session, cwd: project, running: false },
                    },
                  ],
                },
                focused: "p-agent",
              },
              { id: "t2", name: "Second", layout: null, focused: null },
            ],
            activeTab: "t1",
          },
        ],
        active: "w1",
      },
      null,
      2,
    );
    writeText(box.dataFile("workspaces.json"), v1);
    let app = await box.launch();
    const { page } = app;
    expect((await waitForPanels(page, 2)).sort()).toEqual(["p-agent", "p-build"]);
    expect((await tabState(page)).names).toEqual(["Work", "Second"]);
    // Each shell starts in its saved folder; the user's title is kept.
    await waitForScreen(page, "p-build", /project>$/, { joined: true });
    await waitForScreen(page, "p-agent", /other>$/, { joined: true });
    await expect
      .poll(() => page.locator('[data-panel="p-build"] [data-panel-header]').textContent())
      .toContain("Build");
    await app.screenshot("21-v1-file-opens");

    // The v1 bytes were kept, untouched, before anything replaced them.
    const copies = readdirSync(box.dataDir).filter((f) => /^workspaces\.v1-\d+\.json$/.test(f));
    expect(copies).toHaveLength(1);
    expect(readFileSync(join(box.dataDir, copies[0] ?? ""), "utf8")).toBe(v1);
    // Saved as format 2: every panel with its content, the ratios, the agent as it was.
    const saved = await waitFor("the format 2 file", () => {
      const doc = box.savedDocument();
      return doc.version === 2 ? doc : undefined;
    });
    const layout = saved.workspaces[0]?.tabs[0]?.layout ?? null;
    expect(layout?.kind === "split" && layout.ratios).toEqual([0.3, 0.7]);
    const [build, agent] = savedPanels(layout);
    expect(build).toMatchObject({ id: "p-build", title: "Build", content: { kind: "terminal" } });
    expect(sameFolder(build?.content.cwd, project)).toBe(true);
    expect(agent?.content.agent).toEqual({
      agent: "claude-code",
      session,
      cwd: project,
      running: false,
    });
    expect(Object.keys(agent ?? {})).not.toContain("cwd");
    await run(page, "echo after-the-migration");
    await waitForScreen(page, "p-agent", /^after-the-migration$/m);
    await app.quit();

    // The next start reads format 2: no second copy.
    app = await box.launch();
    await waitForPanels(app.page, 2);
    await waitForPrompt(app.page, "p-build");
    expect(readdirSync(box.dataDir).filter((f) => f.startsWith("workspaces.v1-"))).toEqual(copies);
  });

  test("N-05 closing the window and starting again restores its bounds", async () => {
    const box = fresh("bounds");
    // N-01: with close_to_tray off, the window's Close quits as it always did.
    writeText(box.dataFile("settings.toml"), "[window]\nclose_to_tray = false\n");
    let app = await box.launch();
    const start = windowRect(app.pid);
    const target = {
      x: start.x + 40,
      y: start.y + 30,
      width: start.width - 160,
      height: start.height - 90,
    };
    const placed = placeWindow(app.pid, target);
    expect(placed).toEqual(target);
    await waitFor("the saved bounds", () => {
      const saved = JSON.parse(readFileSync(box.dataFile("window.json"), "utf8")) as typeof target;
      return (
        saved.x === target.x &&
        saved.y === target.y &&
        saved.width === target.width &&
        saved.height === target.height
      );
    });
    await app.closeWindow();
    app = await box.launch();
    await waitFor("the window", () => {
      const now = windowRect(app.pid);
      return now.width > 0 ? now : undefined;
    });
    expect(windowRect(app.pid)).toEqual(target);
    await app.screenshot("10-window-bounds-restored");
  });

  test("N-06 Claude Code from the Agents menu types --session-id, and resumes it after a restart", async () => {
    const box = fresh("agent");
    // A stand-in `claude`: the test sees the line WolfCmd types, and no real agent session ever
    // starts (nothing goes to a provider). Detection reads WolfCmd's own PATH (the `bin` copy);
    // the shell gets its PATH from the registry, so it runs the copy in its folder, where
    // Command Prompt looks first.
    const project = box.folder("project");
    // Like a real agent it keeps running (an agent that exits is not started again on restore);
    // only `--version` returns at once.
    const stub =
      '@echo off\r\necho stub-claude %*\r\nif "%~1"=="--version" exit /b 0\r\nset /p _=\r\n';
    writeText(join(box.binDir, "claude.cmd"), stub);
    writeText(join(project, "claude.cmd"), stub);
    let app = await box.launch();
    let { page } = app;
    const shell = await openTerminal(app);
    await run(page, `cd /d "${project}"`);
    await waitForScreen(page, shell, /project>$/, { joined: true });
    // Never the real agent: stop here unless `claude` typed in this folder runs the stand-in
    // (`--version` is harmless either way), and unless the agent panel starts in this folder.
    await run(page, "claude --version");
    await waitForScreen(page, shell, /^stub-claude --version$/m);
    await waitFor("the shell's saved folder", () =>
      sameFolder(
        savedPanels(box.savedDocument().workspaces[0]?.tabs[0]?.layout ?? null)[0]?.content.cwd,
        project,
      ),
    );
    await page.getByRole("button", { name: "Agents" }).click();
    await page.getByRole("menuitem", { name: "Claude Code" }).click();
    const panels = await waitForPanels(page, 2);
    const agent = panels.find((p) => p !== shell) ?? "";
    // The rows run together: a narrow panel wraps the line.
    const started = await waitForScreen(page, agent, /stub-claude --session-id [0-9a-f-]{36}/, {
      joined: true,
    });
    const session = /stub-claude --session-id ([0-9a-f-]{36})/.exec(flat(started))?.[1];
    // Typed at the prompt in the folder (ConPTY may draw it over a prompt that fills the row).
    expect(flat(started)).toMatch(/project>?claude --session-id [0-9a-f-]{36}/);
    expect(started).not.toMatch(/remote-control/);
    const saved = await waitFor("the saved agent panel", () =>
      savedPanels(box.savedDocument().workspaces[0]?.tabs[0]?.layout ?? null).find(
        (p) => p.id === agent,
      ),
    );
    expect(saved.content.agent).toMatchObject({ agent: "claude-code", session });
    expect(sameFolder(saved.content.cwd, project)).toBe(true);
    await app.screenshot("11-agent-claude-session-id");

    // A reload reattaches: the line is not typed again.
    await Promise.all([page.waitForEvent("load"), page.reload()]);
    await waitForPanels(page, 2);
    const replayed = await waitForScreen(page, agent, /stub-claude --session-id/, { joined: true });
    await sleep(1_000);
    expect(flat(await screen(page, agent)).match(/stub-claude/g)?.length).toBe(1);
    expect(flat(replayed)).not.toMatch(/--resume/);

    // A restart resumes exactly that session.
    await app.quit();
    app = await box.launch();
    page = app.page;
    await waitForPanels(page, 2);
    await waitForScreen(page, agent, new RegExp(`stub-claude --resume ${session ?? "?"}`), {
      joined: true,
    });
  });

  test("N-03 a panel dragged by its header onto another one's side moves there, its shell running", async () => {
    const box = fresh("panel-drag");
    const app = await box.launch();
    const { page } = app;
    const a = await openTerminal(app);
    await run(page, "echo still-here");
    await waitForScreen(page, a, /^still-here$/m);
    const b = await split(app, "Equal", 2);

    // Press on a's header, past the threshold, then over the lower part of b.
    const header = await page.locator(`[data-panel="${a}"] [data-panel-header]`).boundingBox();
    const target = await panelBox(page, b);
    if (header === null) throw new Error("no header");
    await page.mouse.move(header.x + 80, header.y + header.height / 2);
    await page.mouse.down();
    await page.mouse.move(header.x + 90, header.y + header.height / 2, { steps: 2 });
    await page.mouse.move(target.x + target.width / 2, target.y + target.height * 0.9, {
      steps: 8,
    });
    await page.locator("[data-drop-zone][data-shown][data-zone=down]").waitFor();
    await app.screenshot("13-panel-drag-preview");
    await page.mouse.up();

    // a is now below b, in a column; it is the same panel, and its shell kept its screen.
    await waitFor("a below b in the saved layout", () => {
      const layout = box.savedDocument().workspaces[0]?.tabs[0]?.layout ?? null;
      return (
        layout?.kind === "split" &&
        layout.direction === "column" &&
        savedPanels(layout)
          .map((p) => p.id)
          .join() === [b, a].join()
      );
    });
    const moved = await panelBox(page, a);
    const above = await panelBox(page, b);
    expect(moved.y).toBeGreaterThan(above.y + above.height - 1);
    expect(await screen(page, a)).toMatch(/^still-here$/m);
    await waitForFocus(page, a);
    await run(page, "echo after-the-move");
    await waitForScreen(page, a, /^after-the-move$/m);
    expect(await page.locator("[data-drop-zone][data-shown]").count()).toBe(0);
    await app.screenshot("14-panel-moved");
  });

  test("N-03 a tab pill dragged sideways reorders the tabs; Esc puts it back", async () => {
    const box = fresh("pill-drag");
    const app = await box.launch();
    const { page } = app;
    await emptyTabButton(app).waitFor();
    await page.keyboard.press("Control+Shift+T");
    await waitForTabs(page, 2, 1);
    await page.keyboard.press("Control+Shift+T");
    await waitForTabs(page, 3, 2);
    const ids = await waitFor("three saved tabs", () => {
      const tabs = box.savedDocument().workspaces[0]?.tabs ?? [];
      return tabs.length === 3 ? tabs.map((t) => t.id) : undefined;
    });
    const pills = page.locator("header [role=tab]");
    const drag = async (from: number, to: number, cancel: boolean) => {
      const start = await pills.nth(from).boundingBox();
      const end = await pills.nth(to).boundingBox();
      if (start === null || end === null) throw new Error("no pill");
      const y = start.y + start.height / 2;
      await page.mouse.move(start.x + 20, y);
      await page.mouse.down();
      await page.mouse.move(start.x + 30, y, { steps: 2 });
      await page.mouse.move(end.x + end.width - 10, y, { steps: 8 });
      if (cancel) await page.keyboard.press("Escape");
      await page.mouse.up();
    };

    // Esc: nothing moves.
    await drag(0, 2, true);
    await sleep(500);
    expect(box.savedDocument().workspaces[0]?.tabs.map((t) => t.id)).toEqual(ids);

    // The first pill dragged past the last: it goes last, and stays the shown tab.
    await drag(0, 2, false);
    await waitFor("the reordered tabs", () => {
      const saved = box.savedDocument().workspaces[0];
      return (
        saved?.tabs.map((t) => t.id).join() === [ids[1], ids[2], ids[0]].join() &&
        saved.activeTab === ids[0]
      );
    });
    await waitForTabs(page, 3, 2);
    await app.screenshot("15-pill-reordered");
  });

  test("N-06 the right bar's + adds a terminal: the default shell, or a chosen one", async () => {
    const app = await fresh("add").launch();
    const { page } = app;
    await emptyTabButton(app).waitFor();
    await page.getByRole("button", { name: "Add" }).click();
    const terminal = page.getByRole("menuitem", { name: /^Terminal/ });
    await terminal.waitFor();
    await app.screenshot("16-add-flyout");
    await terminal.click();
    const [first] = await waitForPanels(page, 1);
    if (first === undefined) throw new Error("no panel");
    await waitForPrompt(page, first);
    await run(page, "echo from-the-add-button");
    await waitForScreen(page, first, /^from-the-add-button$/m);

    // A chosen shell: Command Prompt, split next to the focused panel.
    await page.getByRole("menu").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Add" }).click();
    await page.getByRole("menuitem", { name: "Command Prompt", exact: true }).click();
    const panels = await waitForPanels(page, 2);
    const second = panels.find((p) => p !== first) ?? "";
    await waitForFocus(page, second);
    await waitForPrompt(page, second);
    await app.screenshot("17-added-terminals");
  });
});
