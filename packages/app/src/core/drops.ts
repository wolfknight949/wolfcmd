// N-02: files dragged onto the window from Explorer, Finder or a file manager. Tauri's native
// drag and drop gives the absolute paths and a position (the page's own HTML drop events don't
// carry paths). Privacy: only the dropped paths are handed on, on the user's drop; nothing is
// read, opened, run or sent anywhere here.
import { getCurrentWebview } from "@tauri-apps/api/webview";

interface Point {
  readonly x: number;
  readonly y: number;
}

/** What we use of Tauri's `DragDropEvent` (positions are physical pixels in the webview). */
export type NativeDrag =
  | { readonly type: "enter"; readonly paths: readonly string[]; readonly position: Point }
  | { readonly type: "over"; readonly position: Point }
  | { readonly type: "drop"; readonly paths: readonly string[]; readonly position: Point }
  | { readonly type: "leave" };

/** A drag of files over the window, positions in CSS pixels (viewport coordinates). */
export type FileDrag =
  | {
      readonly type: "enter" | "drop";
      readonly paths: readonly string[];
      readonly x: number;
      readonly y: number;
    }
  | { readonly type: "over"; readonly x: number; readonly y: number }
  | { readonly type: "leave" };

/**
 * Tauri's drag event in CSS pixels (`scale` is `devicePixelRatio`), without empty paths. A drag
 * of something that is not a file (text, a link) has no paths and so never aims anywhere.
 */
export function toFileDrag(event: NativeDrag, scale: number): FileDrag {
  if (event.type === "leave") return event;
  const factor = scale > 0 ? scale : 1;
  const x = event.position.x / factor;
  const y = event.position.y / factor;
  if (event.type === "over") return { type: "over", x, y };
  return { type: event.type, paths: event.paths.filter((path) => path !== ""), x, y };
}

/** Listens to files dragged over the window; returns how to stop. Outside Tauri: nothing. */
export function watchFileDrags(listener: (drag: FileDrag) => void): () => void {
  let stop: (() => void) | undefined;
  let stopped = false;
  try {
    getCurrentWebview()
      .onDragDropEvent((event) => {
        listener(toFileDrag(event.payload, window.devicePixelRatio));
      })
      .then(
        (unlisten) => {
          if (stopped) unlisten();
          else stop = unlisten;
        },
        (error: unknown) => {
          console.debug("file drops unavailable", error);
        },
      );
  } catch (error) {
    console.debug("file drops unavailable", error);
  }
  return () => {
    stopped = true;
    stop?.();
    stop = undefined;
  };
}
