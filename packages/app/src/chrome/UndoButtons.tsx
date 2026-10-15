// N-11: Undo and Redo in the title bar, beside the workspace switcher: two quiet line icons,
// disabled when there is nothing to undo or redo; the tooltips name the step ("Undo close
// panel"). A press leaves the keyboard where it is (the terminal keeps it).
import { IconButton } from "@wolfcmd/ui-kit";
import { useStore } from "zustand";

import type { Actions } from "../actions";
import type { WorkspaceStore } from "../store/workspaces";
import { HINTS } from "./context-menus";
import { keepKeyboard } from "./focus";

export interface UndoButtonsProps {
  readonly store: WorkspaceStore;
  readonly actions: Actions;
}

export function UndoButtons({ store, actions }: UndoButtonsProps) {
  const undo = useStore(store, (s) => s.undo);
  const redo = useStore(store, (s) => s.redo);
  return (
    <div className="flex shrink-0 items-center">
      <IconButton
        icon="undo"
        label={undo === null ? "Undo" : `Undo ${undo} (${HINTS.undo})`}
        disabled={undo === null}
        onMouseDown={keepKeyboard}
        onClick={() => {
          actions.undo();
        }}
      />
      <IconButton
        icon="redo"
        label={redo === null ? "Redo" : `Redo ${redo} (${HINTS.redo})`}
        disabled={redo === null}
        onMouseDown={keepKeyboard}
        onClick={() => {
          actions.redo();
        }}
      />
    </div>
  );
}
