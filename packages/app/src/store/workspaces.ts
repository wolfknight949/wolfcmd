// N-03 / N-05: the workspace document the UI shows. Every change is a pure function of the
// document (`model/`); the store applies it and hands the result to the core, which saves it.
// N-11: a change named by a `Step` is undoable: the store keeps the history (`model/history.ts`,
// memory only) and tells the core which closed panels an undo can still bring back, so their
// sessions keep running a while.
import type { Document } from "@wolfcmd/bindings";
import { createStore, type StoreApi } from "zustand/vanilla";

import {
  EMPTY_HISTORY,
  type History,
  type Moved,
  record,
  redo,
  redoLabel,
  type Step,
  undo,
  undoablePanels,
  undoLabel,
} from "../model/history";

export interface WorkspacesState {
  readonly document: Document;
  /** Written by a newer WolfCmd: nothing is saved. */
  readonly readOnly: boolean;
  /** N-11: what undo would undo ("close panel"), `null` when nothing. */
  readonly undo: string | null;
  /** N-11: what redo would do again, `null` when nothing. */
  readonly redo: string | null;
}

/** N-11: the document to save and the closed panels an undo can bring back. */
export type Save = (document: Document, undoable: readonly string[]) => void;

export interface WorkspaceStore extends StoreApi<WorkspacesState> {
  /**
   * Applies `change` and saves the result (nothing when it returns the same document). N-11:
   * with a `step`, the change can be undone.
   */
  readonly apply: (change: (document: Document) => Document, step?: Step) => void;
  /** N-11: undoes the newest step (`undefined` when there was none). */
  readonly undo: () => Moved | undefined;
  /** N-11: does the newest undone step again (`undefined` when there was none). */
  readonly redo: () => Moved | undefined;
  /** N-11: the closed panels an undo or redo can bring back. */
  readonly undoable: () => readonly string[];
  /** N-11: forgets every step (a git worktree was removed: nothing before it can come back). */
  readonly forget: () => void;
}

export function createWorkspaceStore(
  initial: Pick<WorkspacesState, "document" | "readOnly">,
  save: Save,
  now: () => number = Date.now,
): WorkspaceStore {
  const store = createStore<WorkspacesState>(() => ({ ...initial, undo: null, redo: null }));
  let history: History = EMPTY_HISTORY;
  const commit = (document: Document, next: History) => {
    const changed = document !== store.getState().document;
    history = next;
    store.setState({ document, undo: undoLabel(history), redo: redoLabel(history) });
    if (changed && !store.getState().readOnly) save(document, undoablePanels(history, document));
  };
  const move = (moved: Moved | undefined) => {
    if (moved !== undefined) commit(moved.document, moved.history);
    return moved;
  };
  return Object.assign(store, {
    apply(change: (document: Document) => Document, step?: Step) {
      const { document } = store.getState();
      const next = change(document);
      if (next === document) return;
      commit(next, step === undefined ? history : record(history, document, next, step, now()));
    },
    undo: () => move(undo(history, store.getState().document)),
    redo: () => move(redo(history, store.getState().document)),
    undoable: () => undoablePanels(history, store.getState().document),
    forget() {
      history = EMPTY_HISTORY;
      store.setState({ undo: null, redo: null });
    },
  });
}
