// N-03: what the tab pill's menu does (duplicate, close others, close to the right) and renaming
// a panel from its header's menu.
import type { Document, Layout } from "@wolfcmd/bindings";
import { describe, expect, it } from "vitest";

import {
  activeWorkspace,
  closeOtherTabs,
  closeTabsToRight,
  duplicateTab,
  renamePanel,
} from "./document";
import { leaf, panelsOf } from "./layout";
import { agentOf, panelFolder, terminalPanel } from "./panels";

const agentPanel: Layout = leaf(
  terminalPanel(
    "p2",
    {
      cwd: "C:\\dev\\app",
      agent: { agent: "claude-code", session: "old-session", cwd: "C:\\dev\\app", running: false },
    },
    "Build",
  ),
);

const doc: Document = {
  version: 2,
  active: "w1",
  workspaces: [
    {
      id: "w1",
      name: "",
      folder: "C:\\dev\\app",
      activeTab: "t2",
      tabs: [
        { id: "t1", name: "One", layout: null, focused: null },
        {
          id: "t2",
          name: "Two",
          focused: "p2",
          maximized: "p2",
          layout: {
            kind: "split",
            id: "s1",
            direction: "row",
            ratios: [0.3, 0.7],
            children: [leaf(terminalPanel("p1", { cwd: "C:\\dev\\app\\src" })), agentPanel],
          },
        },
        { id: "t3", name: "Three", layout: null, focused: null },
        { id: "t4", name: "Four", layout: null, focused: null },
      ],
    },
  ],
};

const ids = () => {
  let n = 0;
  return () => `new${String((n += 1))}`;
};
const tabNames = (d: Document) => activeWorkspace(d)?.tabs.map((t) => t.name) ?? [];

describe("N-03 tab menu actions", () => {
  it("n03_duplicate_tab: a copy right after it, shown, with fresh IDs and fresh agents", () => {
    const { document: next, panels } = duplicateTab(doc, "t2", ids());
    const workspace = activeWorkspace(next);
    expect(tabNames(next)).toEqual(["One", "Two", "Two", "Three", "Four"]);
    const copy = workspace?.tabs[2];
    expect(workspace?.activeTab).toBe(copy?.id);
    if (copy?.layout == null) throw new Error("no layout");
    const leaves = panelsOf(copy.layout);
    expect(leaves.map((p) => p.id)).toEqual(panels);
    expect(panels).not.toContain("p1");
    expect(panels).not.toContain("p2");
    expect(leaves.map(panelFolder)).toEqual(["C:\\dev\\app\\src", "C:\\dev\\app"]);
    expect(copy.layout.kind === "split" ? copy.layout.ratios : []).toEqual([0.3, 0.7]);
    // The agent starts anew: a new session, running.
    const agent = leaves[1] === undefined ? undefined : agentOf(leaves[1]);
    expect(agent?.session).not.toBe("old-session");
    expect(agent?.running).toBe(true);
    expect(leaves[1]?.title).toBe("Build");
    // The focus and the maximize follow the copied panel.
    expect(copy.focused).toBe(leaves[1]?.id);
    expect(copy.maximized).toBe(leaves[1]?.id);
  });

  it("n03_close_others: only that tab is left, shown", () => {
    const next = closeOtherTabs(doc, "t3");
    expect(tabNames(next)).toEqual(["Three"]);
    expect(activeWorkspace(next)?.activeTab).toBe("t3");
    expect(closeOtherTabs(next, "t3")).toBe(next);
  });

  it("n03_close_right: the tabs after it close; the shown one stays when it is left", () => {
    const keep = closeTabsToRight(doc, "t2");
    expect(tabNames(keep)).toEqual(["One", "Two"]);
    expect(activeWorkspace(keep)?.activeTab).toBe("t2");
    const moved = closeTabsToRight(doc, "t1");
    expect(tabNames(moved)).toEqual(["One"]);
    expect(activeWorkspace(moved)?.activeTab).toBe("t1");
    expect(closeTabsToRight(doc, "t4")).toBe(doc);
  });

  it("n03_rename_panel: the user's title, or the program's again when empty", () => {
    const leaf = (d: Document) => {
      const layout = activeWorkspace(d)?.tabs[1]?.layout;
      return layout == null ? undefined : panelsOf(layout).find((p) => p.id === "p1");
    };
    const named = renamePanel(doc, "p1", "  Server ");
    expect(leaf(named)?.title).toBe("Server");
    expect(leaf(renamePanel(named, "p1", " "))?.title).toBeNull();
  });
});
