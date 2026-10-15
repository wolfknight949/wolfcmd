import type { Document, GitRepository, Layout, Workspace } from "@wolfcmd/bindings";
import { describe, expect, it } from "vitest";

import {
  closeWorkspace,
  copyTabsInto,
  createWorktreeWorkspace,
  mainOf,
  remapFolder,
  workspacePanels,
  worktreesOf,
} from "./document";
import { leaf, panelsOf } from "./layout";
import { agentOf, panelFolder, terminalPanel } from "./panels";
import { branchUse, defaultWorktreePath, menuRows, titleName } from "./worktrees";

const ids = () => {
  let n = 0;
  return () => `new${String((n += 1))}`;
};

const MAIN = String.raw`C:\dev\my app`;
const TREE = String.raw`C:\dev\my app.worktrees\fix`;

/** A main workspace `app` with two tabs: a split (a shell and an agent) and an empty tab. */
function mainDocument(): Document {
  const layout: Layout = {
    kind: "split",
    id: "s1",
    direction: "row",
    ratios: [0.3, 0.7],
    children: [
      leaf(terminalPanel("p1", { profile: "pwsh", cwd: `${MAIN}\\src` }, "build")),
      leaf(
        terminalPanel("p2", {
          cwd: MAIN,
          agent: {
            agent: "claude-code",
            session: "3f2a1c9e-0b1d-4f6a-8c2e-9a7b5d4c3e21",
            cwd: `${MAIN}\\packages`,
            running: false,
          },
        }),
      ),
    ],
  };
  const app: Workspace = {
    id: "app",
    name: "",
    folder: MAIN,
    tabs: [
      { id: "t1", name: "Work", layout, focused: "p2" },
      { id: "t2", name: "", layout: null, focused: null },
    ],
    activeTab: "t2",
  };
  const other: Workspace = {
    id: "other",
    name: "",
    folder: String.raw`C:\dev\other`,
    tabs: [{ id: "t3", name: "", layout: null, focused: null }],
  };
  return { version: 2, workspaces: [app, other], active: "app" };
}

describe("N-10 copying tabs into a worktree", () => {
  it("moves folders inside the main tree to the same place in the worktree", () => {
    expect(remapFolder(`${MAIN}\\src\\lib`, MAIN, TREE)).toBe(`${TREE}\\src\\lib`);
    expect(remapFolder("c:/DEV/my app/", MAIN, TREE)).toBe(TREE);
    expect(remapFolder(String.raw`C:\dev\my app-2\src`, MAIN, TREE)).toBe(
      String.raw`C:\dev\my app-2\src`,
    );
    expect(remapFolder(String.raw`D:\elsewhere`, MAIN, TREE)).toBe(String.raw`D:\elsewhere`);
    expect(remapFolder("/home/me/app/src", "/home/me/app", "/home/me/app.worktrees/x")).toBe(
      "/home/me/app.worktrees/x/src",
    );
  });

  it("gives every tab, split and panel a fresh ID; agents become fresh agents", () => {
    const main = mainDocument().workspaces[0];
    if (main === undefined) throw new Error("missing");
    const copied = copyTabsInto(main.tabs, main.activeTab, MAIN, TREE, ids());
    expect(copied.tabs.map((t) => t.name)).toEqual(["Work", ""]);
    const [work, empty] = copied.tabs;
    if (work?.layout?.kind !== "split") throw new Error("a split");
    expect(empty?.layout).toBeNull();
    expect(copied.activeTab).toBe(empty?.id);
    const old = new Set(["t1", "t2", "s1", "p1", "p2"]);
    const fresh = [work.id, empty?.id, work.layout.id, ...panelsOf(work.layout).map((p) => p.id)];
    expect(fresh.some((id) => id === undefined || old.has(id))).toBe(false);
    expect(new Set(fresh).size).toBe(fresh.length);
    expect(work.layout.ratios).toEqual([0.3, 0.7]);
    const [shell, agent] = panelsOf(work.layout);
    // The focus follows the copy of the focused panel.
    expect(work.focused).toBe(agent?.id);
    // N-03: so does a maximized panel.
    const maximized = copyTabsInto(
      main.tabs.map((t) => (t.id === "t1" ? { ...t, maximized: "p2" } : t)),
      main.activeTab,
      MAIN,
      TREE,
      ids(),
    ).tabs[0];
    expect(maximized?.maximized).toBeTruthy();
    expect(maximized?.maximized).toBe(maximized?.focused);
    expect(shell).toMatchObject({
      title: "build",
      content: { kind: "terminal", profile: "pwsh", cwd: `${TREE}\\src` },
    });
    expect(agent === undefined ? null : panelFolder(agent)).toBe(TREE);
    const ref = agent === undefined ? undefined : agentOf(agent);
    expect(ref?.agent).toBe("claude-code");
    expect(ref?.session).not.toBe("3f2a1c9e-0b1d-4f6a-8c2e-9a7b5d4c3e21");
    expect(ref?.session).toMatch(/^new/);
    expect(ref?.cwd).toBe(`${TREE}\\packages`);
    expect(ref?.running).toBe(true);
  });

  it("an agent without a session ID (Codex) stays without one", () => {
    const copied = copyTabsInto(
      [
        {
          id: "t",
          layout: leaf(
            terminalPanel("p", {
              cwd: null,
              agent: { agent: "codex", session: null, cwd: null, running: true },
            }),
          ),
          focused: "p",
        },
      ],
      "t",
      MAIN,
      TREE,
      ids(),
    );
    const panel = copied.tabs[0]?.layout;
    expect(panel?.kind === "panel" && agentOf(panel)).toEqual({
      agent: "codex",
      session: null,
      cwd: null,
      running: true,
    });
  });
});

describe("N-10 worktree workspaces", () => {
  it("open after their main workspace, linked to it, empty or with copied tabs", () => {
    const newId = ids();
    const made = createWorktreeWorkspace(mainDocument(), "app", TREE, "fix", MAIN, newId);
    let doc = made.document;
    const fix = doc.workspaces[1];
    if (fix === undefined) throw new Error("missing");
    // N-10: the copied panels are named (their agents start fresh), and only those.
    expect(made.panels).toEqual(workspacePanels(fix).map((p) => p.id));
    expect(doc.workspaces.map((w) => w.id)).toEqual(["app", fix.id, "other"]);
    expect(doc.active).toBe(fix.id);
    expect(fix).toMatchObject({ name: "fix", folder: TREE, main: "app" });
    expect(fix.tabs).toHaveLength(2);
    expect(workspacePanels(fix).map((p) => [panelFolder(p), agentOf(p)?.agent])).toEqual([
      [String.raw`${TREE}\src`, undefined],
      [TREE, "claude-code"],
    ]);
    expect(fix.activeTab).toBe(fix.tabs[1]?.id);
    expect(mainOf(doc, fix)?.id).toBe("app");
    expect(titleName(doc, fix)).toBe("my app › fix");

    const second = String.raw`C:\dev\my app.worktrees\docs`;
    const empty = createWorktreeWorkspace(doc, "app", second, "docs", null, newId);
    expect(empty.panels).toEqual([]);
    doc = empty.document;
    const docs = doc.workspaces[2];
    expect(docs?.tabs).toHaveLength(1);
    expect(docs?.tabs[0]?.layout).toBeNull();
    expect(worktreesOf(doc, "app").map((w) => w.name)).toEqual(["fix", "docs"]);

    // The same folder again: shown, not made twice.
    const again = createWorktreeWorkspace(
      doc,
      "app",
      "c:/dev/my app.worktrees/fix",
      "x",
      null,
      newId,
    );
    expect(again.document.workspaces).toHaveLength(doc.workspaces.length);
    expect(again.document.active).toBe(fix.id);
    expect(again.panels).toEqual([]);
    // N-10: its main workspace gone (closed while git worked): nothing made, nothing copied.
    const gone = createWorktreeWorkspace(doc, "missing", "C:/dev/x", "x", MAIN, newId);
    expect(gone).toEqual({ document: doc, panels: [] });
  });

  it("become plain workspaces when their main workspace closes", () => {
    const newId = ids();
    let doc = createWorktreeWorkspace(mainDocument(), "app", TREE, "fix", null, newId).document;
    doc = closeWorkspace(doc, "app", newId);
    const fix = doc.workspaces.find((w) => w.folder === TREE);
    expect(fix?.main).toBeNull();
    if (fix === undefined) throw new Error("missing");
    expect(mainOf(doc, fix)).toBeUndefined();
    expect(titleName(doc, fix)).toBe("fix");
  });
});

describe("N-10 the workspace menu", () => {
  const repository = (extra: GitRepository["worktrees"]): GitRepository => ({
    root: MAIN,
    mainRoot: MAIN,
    branches: ["fix", "main", "outside"],
    worktrees: [
      { path: MAIN, branch: "main", head: "1", isMain: true, locked: false, prunable: false },
      ...extra,
    ],
  });

  it("lists each workspace's worktrees under it, then the ones made outside WolfCmd", () => {
    const doc = createWorktreeWorkspace(mainDocument(), "app", TREE, "fix", null, ids()).document;
    const listed = repository([
      {
        path: "c:/dev/my app.worktrees/fix",
        branch: "fix",
        head: "2",
        isMain: false,
        locked: false,
        prunable: false,
      },
      {
        path: String.raw`C:\dev\outside`,
        branch: "outside",
        head: "3",
        isMain: false,
        locked: true,
        prunable: false,
      },
      {
        path: String.raw`C:\gone`,
        branch: "gone",
        head: "4",
        isMain: false,
        locked: false,
        prunable: true,
      },
    ]);
    const rows = menuRows(doc, new Map([["app", listed]]));
    expect(
      rows.map((row) =>
        row.kind === "workspace"
          ? row.inset
            ? `  ${row.workspace.name ?? ""}`
            : row.workspace.id
          : `  + ${row.worktree.branch ?? ""} (${row.main.id})`,
      ),
    ).toEqual(["app", "  fix", "  + outside (app)", "other"]);
    // Nothing from git for a folder outside a repository, or before the first reading.
    expect(menuRows(doc, new Map([["app", null]]))).toHaveLength(3);
    expect(menuRows(doc, new Map())).toHaveLength(3);
  });

  it("puts a new worktree next to the repository and knows what a branch name means", () => {
    expect(defaultWorktreePath(MAIN, "feature/login")).toBe(
      String.raw`C:\dev\my app.worktrees\feature-login`,
    );
    expect(defaultWorktreePath("C:\\app\\", "x")).toBe(String.raw`C:\app.worktrees\x`);
    expect(defaultWorktreePath("/home/me/app", "a:b")).toBe("/home/me/app.worktrees/a-b");
    expect(defaultWorktreePath(MAIN, " ")).toBe(String.raw`C:\dev\my app.worktrees`);

    const listed = repository([
      { path: TREE, branch: "fix", head: "2", isMain: false, locked: false, prunable: false },
    ]);
    expect(branchUse(listed, "  ")).toEqual({ kind: "none" });
    expect(branchUse(listed, "new-idea")).toEqual({ kind: "new" });
    expect(branchUse(listed, "outside")).toEqual({ kind: "existing" });
    expect(branchUse(listed, "fix")).toEqual({ kind: "taken", path: TREE });
    expect(branchUse(listed, "main")).toEqual({ kind: "taken", path: MAIN });
  });
});
