// N-02: files dropped on a terminal panel insert their paths at its prompt. Each mounted
// terminal registers how it takes them; one listener for the window finds the panel under the
// pointer (its element carries `data-wc-drop`), marks it while the drag is over it (CSS, no
// React state) and hands it the paths on the drop. Nothing else takes files.
import { type FileDrag, watchFileDrags } from "../core/drops";

/** The attribute a panel's terminal element carries (its panel ID). */
const DROP_ATTRIBUTE = "data-wc-drop";
/** Set on the element while files are dragged over it (styles.css draws the frame and label). */
const OVER_ATTRIBUTE = "data-wc-drop-over";

/** What the panel under the pointer does with dropped paths (typed, never with Enter). */
export type DropHandler = (paths: readonly string[]) => void;

const handlers = new Map<string, DropHandler>();

/** A panel takes dropped files (`undefined`: not any more). */
export function setDropHandler(panelId: string, handler: DropHandler | undefined): void {
  if (handler === undefined) handlers.delete(panelId);
  else handlers.set(panelId, handler);
}

/** The label on the panel while files are over it. */
export function dropLabel(count: number): string {
  return count === 1 ? "Insert path" : `Insert ${String(count)} paths`;
}

/** Follows file drags over the window (call once, at start); returns how to stop. */
export function installFileDrops(root: Document = document): () => void {
  let paths: readonly string[] = [];
  let over: HTMLElement | undefined;
  const aim = (target: HTMLElement | undefined) => {
    if (target === over) return;
    over?.removeAttribute(OVER_ATTRIBUTE);
    over = target;
    over?.setAttribute(OVER_ATTRIBUTE, dropLabel(paths.length));
  };
  const panelAt = (x: number, y: number): HTMLElement | undefined => {
    if (paths.length === 0) return undefined;
    const element = root.elementFromPoint(x, y)?.closest<HTMLElement>(`[${DROP_ATTRIBUTE}]`);
    if (element == null) return undefined;
    const id = element.getAttribute(DROP_ATTRIBUTE);
    return id !== null && handlers.has(id) ? element : undefined;
  };
  return watchFileDrags((drag: FileDrag) => {
    switch (drag.type) {
      case "enter":
        paths = drag.paths;
        aim(panelAt(drag.x, drag.y));
        return;
      case "over":
        aim(panelAt(drag.x, drag.y));
        return;
      case "drop": {
        paths = drag.paths;
        const target = panelAt(drag.x, drag.y);
        aim(undefined);
        const id = target?.getAttribute(DROP_ATTRIBUTE);
        if (id != null) handlers.get(id)?.(drag.paths);
        paths = [];
        return;
      }
      case "leave":
        aim(undefined);
        paths = [];
    }
  });
}
