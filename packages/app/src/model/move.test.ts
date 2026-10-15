// N-03 moving panels by drag and drop (layout and document), and N-01 workspace colors.
import { describe, expect, it } from "vitest";

import {
  activeTab,
  activeWorkspace,
  createWorkspace,
  dropPanel,
  emptyDocument,
  openPanel,
  WORKSPACE_COLORS,
  workspaceColor,
} from "./document";
import {
  findPanel,
  insertPanel,
  leaf,
  movePanel,
  panelsOf,
  splitPanel,
  swapPanels,
} from "./layout";
import { terminalPanel } from "./panels";

const ids = () => {
  let n = 0;
  return () => `id${String((n += 1))}`;
};

const one = leaf(terminalPanel("a"));
const ab = splitPanel(one, "a", "right", terminalPanel("b"), "s1");

describe("N-03 moving panels", () => {
  it("n03_move_panel: a panel dropped on a side splits there and keeps its ID", () => {
    // b to the left of a: the same row, b first.
    const left = movePanel(ab, "b", "a", "left", "s2");
    expect(panelsOf(left).map((p) => p.id)).toEqual(["b", "a"]);
    expect(left).toMatchObject({ kind: "split", direction: "row" });
    // b above a: a column of b, then a.
    const up = movePanel(ab, "b", "a", "up", "s2");
    expect(up).toMatchObject({ kind: "split", id: "s2", direction: "column" });
    expect(panelsOf(up).map((p) => p.id)).toEqual(["b", "a"]);
    // c, out of a nested split, below a; it keeps everything it had.
    const abc = splitPanel(ab, "b", "down", terminalPanel("c", { cwd: "C:\\dev" }), "s3");
    const moved = movePanel(abc, "c", "a", "down", "s4");
    expect(panelsOf(moved).map((p) => p.id)).toEqual(["a", "c", "b"]);
    expect(findPanel(moved, "c")).toMatchObject({ content: { cwd: "C:\\dev" } });
  });

  it("n03_move_nothing: onto itself or a missing panel, the same layout", () => {
    expect(movePanel(ab, "a", "a", "left", "s2")).toBe(ab);
    expect(movePanel(ab, "a", "zz", "left", "s2")).toBe(ab);
    expect(movePanel(one, "a", "a", "down", "s2")).toBe(one);
  });

  it("n03_swap_panels: the centre swaps two panels, the splits stay", () => {
    const swapped = swapPanels(ab, "a", "b");
    expect(panelsOf(swapped).map((p) => p.id)).toEqual(["b", "a"]);
    expect(swapped).toMatchObject({ id: "s1", ratios: [0.5, 0.5] });
    expect(swapPanels(ab, "a", "a")).toBe(ab);
  });

  it("n03_insert_panel: before the target on the left and up sides", () => {
    const row = insertPanel(ab, "b", "left", leaf(terminalPanel("c")), "s2");
    expect(panelsOf(row).map((p) => p.id)).toEqual(["a", "c", "b"]);
    expect(row).toMatchObject({ ratios: [0.5, 0.25, 0.25] });
  });

  it("n03_drop_panel: a side moves it there, the centre swaps; it gets the focus", () => {
    const newId = ids();
    let doc = emptyDocument(newId);
    doc = openPanel(doc, terminalPanel("a"), "right", newId);
    doc = openPanel(doc, terminalPanel("b"), "right", newId);
    const layoutOf = (d: typeof doc) => activeTab(activeWorkspace(d))?.layout;
    const below = dropPanel(doc, "a", "b", "down", newId);
    expect(layoutOf(below)).toMatchObject({ kind: "split", direction: "column" });
    expect(activeTab(activeWorkspace(below))?.focused).toBe("a");
    const swapped = layoutOf(dropPanel(doc, "a", "b", "center", newId));
    expect(swapped == null ? [] : panelsOf(swapped).map((p) => p.id)).toEqual(["b", "a"]);
    expect(dropPanel(doc, "a", "a", "left", newId)).toBe(doc);
    expect(dropPanel(doc, "a", "missing", "left", newId)).toBe(doc);
  });
});

describe("N-01 workspace colors", () => {
  it("n01_workspace_color: stable per workspace, 1 to 8; a worktree shares its main's", () => {
    const newId = ids();
    let doc = createWorkspace(emptyDocument(newId), "C:\\dev\\app", newId);
    const [first, second] = doc.workspaces;
    if (first === undefined || second === undefined) throw new Error("two workspaces");
    const color = workspaceColor(doc, first);
    expect(color).toBeGreaterThanOrEqual(1);
    expect(color).toBeLessThanOrEqual(WORKSPACE_COLORS);
    expect(workspaceColor(doc, first)).toBe(color);
    doc = { ...doc, workspaces: [...doc.workspaces, { ...second, id: "wt", main: first.id }] };
    const worktree = doc.workspaces.find((w) => w.id === "wt");
    if (worktree === undefined) throw new Error("worktree");
    expect(workspaceColor(doc, worktree)).toBe(color);
  });
});
