import type { Document } from "@wolfcmd/bindings";
import { describe, expect, it } from "vitest";

import {
  activateTab,
  activeTab,
  activeWorkspace,
  addTab,
  changePanel,
  closePanel,
  closeTab,
  emptyDocument,
  openPanel,
  renamePanel,
} from "./document";
import {
  EMPTY_HISTORY,
  GROUP_WINDOW_MS,
  HISTORY_DEPTH,
  type History,
  record,
  redo,
  redoLabel,
  undo,
  undoablePanels,
  undoLabel,
} from "./history";
import { panelsOf } from "./layout";
import { panelFolder, terminalPanel, withCwd } from "./panels";

const ids = () => {
  let n = 0;
  return () => `id${String((n += 1))}`;
};

/** Panel `id`, wherever it is. */
const panelIn = (doc: Document, id: string) =>
  doc.workspaces
    .flatMap((w) => w.tabs)
    .flatMap((t) => (t.layout == null ? [] : panelsOf(t.layout)))
    .find((p) => p.id === id);

const shownPanels = (doc: Document) => {
  const layout = activeTab(activeWorkspace(doc))?.layout;
  return layout == null ? [] : panelsOf(layout).map((p) => p.id);
};

/** A document with panels a and b side by side in the shown tab, and the history so far. */
function twoPanels() {
  const newId = ids();
  let doc = emptyDocument(newId);
  let history: History = EMPTY_HISTORY;
  const step = (change: (d: Document) => Document, label: string, at = 0) => {
    const next = change(doc);
    history = record(history, doc, next, { label }, at);
    doc = next;
  };
  step((d) => openPanel(d, terminalPanel("a"), "right", newId), "new terminal");
  step((d) => openPanel(d, terminalPanel("b"), "right", newId), "split right");
  return {
    newId,
    get doc() {
      return doc;
    },
    set doc(next: Document) {
      doc = next;
    },
    get history() {
      return history;
    },
    set history(next: History) {
      history = next;
    },
    step,
  };
}

describe("N-11 undo history", () => {
  it("n11_history: undo brings the document before a step back, redo the one after", () => {
    const s = twoPanels();
    expect(undoLabel(s.history)).toBe("split right");
    s.step((d) => closePanel(d, "b"), "close panel");
    expect(shownPanels(s.doc)).toEqual(["a"]);

    const undone = undo(s.history, s.doc);
    if (undone === undefined) throw new Error("nothing to undo");
    expect(undone.label).toBe("close panel");
    expect(shownPanels(undone.document)).toEqual(["a", "b"]);
    // The change is on screen: no notice.
    expect(undone.offscreen).toBe(false);
    expect(undoLabel(undone.history)).toBe("split right");
    expect(redoLabel(undone.history)).toBe("close panel");

    const redone = redo(undone.history, undone.document);
    if (redone === undefined) throw new Error("nothing to redo");
    expect(shownPanels(redone.document)).toEqual(["a"]);
    expect(redoLabel(redone.history)).toBeNull();
    expect(undoLabel(redone.history)).toBe("close panel");
  });

  it("n11_history: nothing to undo or redo is undefined", () => {
    const doc = emptyDocument(ids());
    expect(undo(EMPTY_HISTORY, doc)).toBeUndefined();
    expect(redo(EMPTY_HISTORY, doc)).toBeUndefined();
    expect(undoLabel(EMPTY_HISTORY)).toBeNull();
  });

  it("n11_history: a new step drops what could be redone", () => {
    const s = twoPanels();
    const undone = undo(s.history, s.doc);
    if (undone === undefined) throw new Error("nothing to undo");
    s.history = undone.history;
    s.doc = undone.document;
    expect(redoLabel(s.history)).toBe("split right");
    s.step((d) => addTab(d, s.newId), "new tab");
    expect(redoLabel(s.history)).toBeNull();
    expect(undoLabel(s.history)).toBe("new tab");
  });

  it("n11_history: keeps at most HISTORY_DEPTH steps, dropping the oldest", () => {
    const newId = ids();
    let doc = emptyDocument(newId);
    let history: History = EMPTY_HISTORY;
    for (let i = 0; i < HISTORY_DEPTH + 5; i++) {
      const next = addTab(doc, newId);
      history = record(history, doc, next, { label: `tab ${String(i)}` }, i * 10_000);
      doc = next;
    }
    expect(history.past).toHaveLength(HISTORY_DEPTH);
    expect(history.past[0]?.label).toBe("tab 5");
  });

  it("n11_history: a burst of one group is one step, a pause or another group starts a new one", () => {
    const s = twoPanels();
    const rename = (name: string, at: number, group = "rename:a") => {
      const next = renamePanel(s.doc, "a", name);
      s.history = record(s.history, s.doc, next, { label: "rename panel", group }, at);
      s.doc = next;
    };
    const steps = () => s.history.past.length;
    const before = steps();
    rename("x", 1000);
    rename("xy", 1000 + GROUP_WINDOW_MS / 2);
    rename("xyz", 1000 + GROUP_WINDOW_MS - 1);
    expect(steps()).toBe(before + 1);
    // One undo of the burst: the name before it.
    expect(panelIn(undo(s.history, s.doc)?.document ?? s.doc, "a")?.title ?? null).toBeNull();
    rename("later", 10_000);
    expect(steps()).toBe(before + 2);
    rename("other", 10_001, "rename:b");
    expect(steps()).toBe(before + 3);
  });

  it("n11_history: what the terminals reported since a step is kept by undo and redo", () => {
    const s = twoPanels();
    s.step((d) => closePanel(d, "b"), "close panel");
    // The shell of a moved on (not undoable).
    s.doc = changePanel(s.doc, "a", (p) => withCwd(p, "C:\\later"));
    const undone = undo(s.history, s.doc);
    if (undone === undefined) throw new Error("nothing to undo");
    const a = panelIn(undone.document, "a");
    expect(a === undefined ? undefined : panelFolder(a)).toBe("C:\\later");
  });

  it("n11_history: an undo away from the change keeps where the user is and says so", () => {
    const s = twoPanels();
    const firstTab = activeTab(activeWorkspace(s.doc))?.id ?? "";
    s.step((d) => addTab(d, s.newId), "new tab");
    const elsewhere = activeTab(activeWorkspace(s.doc))?.id ?? "";
    s.doc = activateTab(s.doc, firstTab);
    s.step((d) => closePanel(d, "b"), "close panel");
    // The user goes to the other tab (not undoable) and undoes there.
    s.doc = activateTab(s.doc, elsewhere);
    const undone = undo(s.history, s.doc);
    if (undone === undefined) throw new Error("nothing to undo");
    expect(activeTab(activeWorkspace(undone.document))?.id).toBe(elsewhere);
    expect(undone.offscreen).toBe(true);
    const back = activateTab(undone.document, firstTab);
    expect(shownPanels(back)).toEqual(["a", "b"]);
  });

  it("n11_history: undoing a closed tab shows it again when the user stayed", () => {
    const s = twoPanels();
    const closing = activeTab(activeWorkspace(s.doc))?.id ?? "";
    s.step((d) => addTab(d, s.newId), "new tab");
    s.step((d) => activateTab(d, closing), "show tab");
    s.step((d) => closeTab(d, closing, s.newId), "close tab");
    expect(activeTab(activeWorkspace(s.doc))?.id).not.toBe(closing);
    const undone = undo(s.history, s.doc);
    if (undone === undefined) throw new Error("nothing to undo");
    expect(activeTab(activeWorkspace(undone.document))?.id).toBe(closing);
    expect(shownPanels(undone.document)).toEqual(["a", "b"]);
    expect(undone.offscreen).toBe(false);
  });

  it("n11_history: the panels an undo or redo can bring back are named for the core", () => {
    const s = twoPanels();
    expect(undoablePanels(s.history, s.doc)).toEqual([]);
    s.step((d) => closePanel(d, "b"), "close panel");
    expect(undoablePanels(s.history, s.doc)).toEqual(["b"]);
    const undone = undo(s.history, s.doc);
    if (undone === undefined) throw new Error("nothing to undo");
    expect(undoablePanels(undone.history, undone.document)).toEqual([]);
    // Undoing the split too: b can come back by a redo.
    const twice = undo(undone.history, undone.document);
    if (twice === undefined) throw new Error("nothing to undo");
    expect(undoablePanels(twice.history, twice.document)).toEqual(["b"]);
  });
});
