// N-11: the small notice after an undo or redo whose change the user can't see (it happened in
// another tab or workspace): "Panel restored", "Redone: split right". It shows for a moment;
// a change on screen is its own feedback, so nothing shows then.
import { createStore } from "zustand/vanilla";

/** How long the notice stays. */
const SHOWN_MS = 2400;

/** The notice shown now (`null`: none); a new one replaces it. */
export const undoNotice = createStore<{ readonly text: string; readonly id: number } | null>(
  () => null,
);

let shown = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

/** What the notice says after undoing (`undone`) or redoing step `label`. */
export function noticeText(label: string, undone: boolean): string {
  if (undone && label.startsWith("close ")) {
    const what = label.slice("close ".length);
    if (what === "panel") return "Panel restored";
    if (what === "tab") return "Tab restored";
    if (what === "workspace") return "Workspace restored";
    return "Tabs restored";
  }
  return `${undone ? "Undone" : "Redone"}: ${label}`;
}

/** Shows `text` for a moment. */
export function showUndoNotice(text: string): void {
  shown += 1;
  undoNotice.setState({ text, id: shown }, true);
  clearTimeout(timer);
  timer = setTimeout(() => {
    undoNotice.setState(null, true);
  }, SHOWN_MS);
}
