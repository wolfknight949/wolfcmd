// N-03 panel types: a panel of a kind this WolfCmd doesn't know (a newer WolfCmd's, a plugin's)
// survives every layout operation with its content untouched: the very same object, so every
// field it had is saved back.
import type { Document, PanelContent, Tab } from "@wolfcmd/bindings";
import { describe, expect, it } from "vitest";

import { relaunches, startFolder, withAgent } from "./agents";
import {
  activeWorkspace,
  changePanel,
  closeOtherTabs,
  copyTabsInto,
  dropPanel,
  duplicateTab,
  openPanel,
  renamePanel,
  toggleMaximize,
} from "./document";
import { findPanel, leaf, type PanelLeaf, panelsOf } from "./layout";
import { agentOf, missingType, panelFolder, terminalOf, terminalPanel, withCwd } from "./panels";

/** A plugin's panel with fields of its own (nested, numbers, nulls). */
const BOARD = {
  kind: "acme.board",
  columns: ["todo", "done"],
  view: { zoom: 1.5, filter: null },
} as PanelContent;

const board: PanelLeaf = { kind: "panel", id: "u1", title: "Sprint", content: BOARD };

const ids = () => {
  let n = 0;
  return () => `new${String((n += 1))}`;
};

function docWith(): Document {
  const work: Tab = {
    id: "t1",
    name: "Work",
    focused: "p1",
    layout: {
      kind: "split",
      id: "s1",
      direction: "row",
      ratios: [0.4, 0.6],
      children: [leaf(terminalPanel("p1", { cwd: "C:\\dev\\app" })), board],
    },
  };
  const other: Tab = { id: "t2", name: "Other", layout: null, focused: null };
  return {
    version: 2,
    active: "w1",
    workspaces: [
      { id: "w1", name: "", folder: "C:\\dev\\app", tabs: [work, other], activeTab: "t1" },
    ],
  };
}

const layoutOf = (doc: Document, tab = 0) => activeWorkspace(doc)?.tabs[tab]?.layout ?? null;

/** The unknown panel wherever it is, and that its content is the same object. */
function boardIn(doc: Document, tab = 0): PanelLeaf | undefined {
  const layout = layoutOf(doc, tab);
  return layout == null ? undefined : panelsOf(layout).find((p) => p.content === BOARD);
}

describe("N-03 a panel of an unknown kind", () => {
  it("n03_unknown_split_move_swap: splits next to it, moves and swaps keep it whole", () => {
    let doc = docWith();
    doc = openPanel(doc, terminalPanel("p2"), "down", ids());
    expect(boardIn(doc)).toBe(board);
    for (const zone of ["left", "down", "center"] as const) {
      const moved = dropPanel(doc, "u1", "p1", zone, ids());
      expect(moved).not.toBe(doc);
      expect(boardIn(moved)).toBe(board);
      const back = dropPanel(moved, "p1", "u1", zone, ids());
      expect(boardIn(back)).toBe(board);
    }
    const maximized = toggleMaximize(doc, "u1");
    expect(activeWorkspace(maximized)?.tabs[0]?.maximized).toBe("u1");
    expect(boardIn(maximized)).toBe(board);
  });

  it("n03_unknown_rename: a rename keeps its content", () => {
    const renamed = renamePanel(docWith(), "u1", "Board");
    const panel = boardIn(renamed);
    expect(panel?.title).toBe("Board");
    expect(panel?.content).toBe(BOARD);
  });

  it("n03_unknown_close_others: closing other tabs keeps the tab it is in", () => {
    const closed = closeOtherTabs(docWith(), "t1");
    expect(activeWorkspace(closed)?.tabs).toHaveLength(1);
    expect(boardIn(closed)).toBe(board);
  });

  it("n03_unknown_duplicate: a duplicated tab copies it with a new ID, the same content", () => {
    const { document, panels } = duplicateTab(docWith(), "t1", ids());
    const copy = boardIn(document, 1);
    expect(copy?.id).not.toBe("u1");
    expect(panels).toContain(copy?.id);
    expect(copy?.title).toBe("Sprint");
    expect(copy?.content).toBe(BOARD);
    // The original stays.
    expect(boardIn(document, 0)).toBe(board);
  });

  it("n03_unknown_worktree: copied into a worktree it keeps its content; terminals move", () => {
    const tabs = activeWorkspace(docWith())?.tabs ?? [];
    const copied = copyTabsInto(tabs, "t1", "C:\\dev\\app", "C:\\dev\\app.wt\\fix", ids());
    const layout = copied.tabs[0]?.layout;
    if (layout == null) throw new Error("no layout");
    const [shell, copy] = panelsOf(layout);
    expect(copy?.content).toBe(BOARD);
    expect(copy?.id).not.toBe("u1");
    expect(shell === undefined ? null : panelFolder(shell)).toBe("C:\\dev\\app.wt\\fix");
  });

  it("n03_unknown_terminal_changes: terminal-only changes leave it as it is", () => {
    const doc = docWith();
    expect(changePanel(doc, "u1", (p) => withCwd(p, "C:\\x"))).toBe(doc);
    expect(changePanel(doc, "u1", (p) => withAgent(p, { running: false }))).toBe(doc);
    const panel = findPanel(layoutOf(doc) ?? board, "u1") ?? board;
    expect(terminalOf(panel)).toBeUndefined();
    expect(agentOf(panel)).toBeUndefined();
    expect(panelFolder(panel)).toBeNull();
    expect(relaunches(panel)).toBe(false);
    expect(startFolder(panel)).toBeNull();
  });

  it("n03_missing_type: a dotted kind needs its plugin, a plain one a newer WolfCmd", () => {
    expect(missingType("acme.board")).toEqual({ plugin: "acme" });
    expect(missingType("browser")).toEqual({ newer: true });
    expect(missingType(".odd")).toEqual({ newer: true });
  });
});
