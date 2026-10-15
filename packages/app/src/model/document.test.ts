import { describe, expect, it } from "vitest";

import {
  activateTabNumber,
  activeTab,
  activeWorkspace,
  addTab,
  closePanel,
  closeTab,
  closeWorkspace,
  createWorkspace,
  cycleTab,
  emptyDocument,
  folderKey,
  folderName,
  moveTab,
  openPanel,
  tabName,
  workspaceForFolder,
  workspaceName,
} from "./document";
import { panelsOf } from "./layout";
import { terminalPanel } from "./panels";

const ids = () => {
  let n = 0;
  return () => `id${String((n += 1))}`;
};

describe("N-04 workspaces", () => {
  it("are named by the user, their folder or their position", () => {
    const newId = ids();
    let doc = emptyDocument(newId);
    doc = createWorkspace(doc, "C:\\dev\\app\\", newId);
    const [first, second] = doc.workspaces;
    if (first === undefined || second === undefined) throw new Error("missing");
    expect(workspaceName(doc, first)).toBe("Workspace 1");
    expect(workspaceName(doc, second)).toBe("app");
    expect(workspaceName(doc, { ...second, name: " Docs " })).toBe("Docs");
    expect(workspaceForFolder(doc, "c:/DEV/app")?.id).toBe(second.id);
    expect(folderKey("C:\\Dev\\App\\")).toBe("c:/dev/app");
    expect(folderName("/home/me/game/")).toBe("game");
  });

  it("never close the last one", () => {
    const newId = ids();
    const doc = closeWorkspace(emptyDocument(newId), "id2", newId);
    expect(doc.workspaces).toHaveLength(1);
    expect(doc.workspaces[0]?.id).not.toBe("id2");
    expect(activeTab(activeWorkspace(doc))).toBeDefined();
  });
});

describe("N-03 tabs and panels", () => {
  it("add, cycle, move and close tabs; the last tab becomes an empty one", () => {
    const newId = ids();
    let doc = addTab(addTab(emptyDocument(newId), newId), newId);
    const workspace = () => activeWorkspace(doc);
    expect(workspace()?.tabs.map((t) => t.id)).toEqual(["id1", "id3", "id4"]);
    expect(workspace()?.activeTab).toBe("id4");
    doc = cycleTab(doc, 1);
    expect(workspace()?.activeTab).toBe("id1");
    doc = activateTabNumber(doc, 2);
    expect(workspace()?.activeTab).toBe("id3");
    doc = moveTab(doc, "id4", 0);
    expect(workspace()?.tabs.map((t) => t.id)).toEqual(["id4", "id1", "id3"]);
    const w = workspace();
    const tab = w?.tabs[0];
    if (w === undefined || tab === undefined) throw new Error("missing");
    expect(tabName(w, tab)).toBe("Tab 1");
    for (const id of ["id4", "id1", "id3"]) doc = closeTab(doc, id, newId);
    expect(workspace()?.tabs).toHaveLength(1);
  });

  it("open panels next to the focused one and move the focus when one closes", () => {
    const newId = ids();
    let doc = emptyDocument(newId);
    doc = openPanel(doc, terminalPanel("p1"), "right", newId);
    doc = openPanel(doc, terminalPanel("p2"), "down", newId);
    const layout = () => activeTab(activeWorkspace(doc))?.layout;
    const current = layout();
    if (current == null) throw new Error("no layout");
    expect(panelsOf(current).map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(activeTab(activeWorkspace(doc))?.focused).toBe("p2");
    doc = closePanel(doc, "p2");
    expect(activeTab(activeWorkspace(doc))?.focused).toBe("p1");
    doc = closePanel(doc, "p1");
    expect(layout()).toBeNull();
  });
});
