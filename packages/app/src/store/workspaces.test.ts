import type { Document } from "@wolfcmd/bindings";
import { describe, expect, it, vi } from "vitest";

import { closePanel, createWorkspace, emptyDocument, openPanel } from "../model/document";
import { terminalPanel } from "../model/panels";
import { createWorkspaceStore } from "./workspaces";

const ids = () => {
  let n = 0;
  return () => `id${String((n += 1))}`;
};

describe("N-05 the workspace store", () => {
  it("saves every change and nothing for a change that changes nothing", () => {
    const newId = ids();
    const save = vi.fn<(document: Document) => void>();
    const store = createWorkspaceStore({ document: emptyDocument(newId), readOnly: false }, save);
    store.apply((doc) => createWorkspace(doc, "C:/dev/app", newId));
    expect(save).toHaveBeenCalledOnce();
    expect(store.getState().document.workspaces).toHaveLength(2);
    store.apply((doc) => doc);
    expect(save).toHaveBeenCalledOnce();
  });

  it("never saves a document from a newer WolfCmd", () => {
    const newId = ids();
    const save = vi.fn<(document: Document) => void>();
    const store = createWorkspaceStore({ document: emptyDocument(newId), readOnly: true }, save);
    store.apply((doc) => createWorkspace(doc, null, newId));
    expect(save).not.toHaveBeenCalled();
    expect(store.getState().document.workspaces).toHaveLength(2);
  });
});

describe("N-11 undo in the workspace store", () => {
  it("n11_store: a step can be undone and redone; other changes aren't steps", () => {
    const newId = ids();
    const save = vi.fn<(document: Document, undoable: readonly string[]) => void>();
    const store = createWorkspaceStore({ document: emptyDocument(newId), readOnly: false }, save);
    store.apply((doc) => createWorkspace(doc, "C:/dev/app", newId), { label: "new workspace" });
    expect(store.getState().undo).toBe("new workspace");
    // Not a step (showing another workspace): nothing more to undo.
    const first = store.getState().document.workspaces[0]?.id ?? "";
    store.apply((doc) => ({ ...doc, active: first }));
    expect(store.getState().undo).toBe("new workspace");

    expect(store.undo()?.label).toBe("new workspace");
    expect(store.getState().document.workspaces).toHaveLength(1);
    expect(store.getState().undo).toBeNull();
    expect(store.getState().redo).toBe("new workspace");
    expect(store.redo()?.label).toBe("new workspace");
    expect(store.getState().document.workspaces).toHaveLength(2);
    expect(save).toHaveBeenCalledTimes(4);
    // Nothing left to redo: nothing happens, nothing is saved.
    expect(store.redo()).toBeUndefined();
    expect(save).toHaveBeenCalledTimes(4);
  });

  it("n11_store: no empty steps: a change that changes nothing is not recorded", () => {
    const store = createWorkspaceStore(
      { document: emptyDocument(ids()), readOnly: false },
      vi.fn(),
    );
    store.apply((doc) => doc, { label: "rename tab" });
    expect(store.getState().undo).toBeNull();
  });

  it("n11_store: the core hears which closed panels an undo can bring back", () => {
    const newId = ids();
    const save = vi.fn<(document: Document, undoable: readonly string[]) => void>();
    const store = createWorkspaceStore({ document: emptyDocument(newId), readOnly: false }, save);
    store.apply((doc) => openPanel(doc, terminalPanel("p"), "right", newId), { label: "new" });
    store.apply((doc) => closePanel(doc, "p"), { label: "close panel" });
    expect(save).toHaveBeenLastCalledWith(expect.anything(), ["p"]);
    expect(store.undoable()).toEqual(["p"]);
    store.undo();
    expect(save).toHaveBeenLastCalledWith(expect.anything(), []);
    // Forgotten (a worktree was removed): the next save lets the session go.
    store.forget();
    expect(store.getState().undo).toBeNull();
    store.apply((doc) => closePanel(doc, "p"));
    expect(save).toHaveBeenLastCalledWith(expect.anything(), []);
  });
});
