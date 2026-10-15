import type { Document } from "@wolfcmd/bindings";
import { describe, expect, it, vi } from "vitest";

import { createWorkspace, emptyDocument } from "../model/document";
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
