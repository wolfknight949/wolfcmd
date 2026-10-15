// N-03 / N-05: the workspace document the UI shows. Every change is a pure function of the
// document (`model/`); the store applies it and hands the result to the core, which saves it.
import type { Document } from "@wolfcmd/bindings";
import { createStore, type StoreApi } from "zustand/vanilla";

export interface WorkspacesState {
  readonly document: Document;
  /** Written by a newer WolfCmd: nothing is saved. */
  readonly readOnly: boolean;
}

export interface WorkspaceStore extends StoreApi<WorkspacesState> {
  /** Applies `change` and saves the result (nothing when it returns the same document). */
  readonly apply: (change: (document: Document) => Document) => void;
}

export function createWorkspaceStore(
  initial: WorkspacesState,
  save: (document: Document) => void,
): WorkspaceStore {
  const store = createStore<WorkspacesState>(() => initial);
  return Object.assign(store, {
    apply(change: (document: Document) => Document) {
      const { document, readOnly } = store.getState();
      const next = change(document);
      if (next === document) return;
      store.setState({ document: next });
      if (!readOnly) save(next);
    },
  });
}
