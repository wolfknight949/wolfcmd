// One registry of the overlays on screen. `Menu`, `ContextMenu` and `Dialog` report themselves
// while they are mounted, so the app knows without searching the DOM: Esc goes to the overlay on
// top, and app shortcuts leave the keys to a modal dialog.
import { type RefObject, useLayoutEffect, useRef } from "react";

/** What kind of surface is open. */
export type OverlayKind = "menu" | "dialog";

interface OpenOverlay {
  /** Grows with every opening: a later overlay has a larger ID (it is on top). */
  readonly id: number;
  readonly kind: OverlayKind;
}

export interface OverlayHandle {
  readonly id: number;
  /** Reports the overlay closed (idempotent). */
  readonly close: () => void;
}

let open: readonly OpenOverlay[] = [];
let lastId = 0;

/** Reports an overlay as open until the handle's `close` is called. */
export function openOverlay(kind: OverlayKind): OverlayHandle {
  lastId += 1;
  const id = lastId;
  open = [...open, { id, kind }];
  return {
    id,
    close: () => {
      open = open.filter((overlay) => overlay.id !== id);
    },
  };
}

/** Whether `id` is the overlay on top (opened last and still open). */
export function isTopOverlay(id: number | undefined): boolean {
  return id !== undefined && open.at(-1)?.id === id;
}

/**
 * Reports an overlay of `kind` while the component is mounted (and `active`). The ref holds its
 * ID for event handlers (`isTopOverlay`); a layout effect, so the registry knows before paint.
 */
export function useOverlay(kind: OverlayKind, active = true): RefObject<number | undefined> {
  const id = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (!active) return;
    const handle = openOverlay(kind);
    id.current = handle.id;
    return () => {
      handle.close();
      id.current = undefined;
    };
  }, [kind, active]);
  return id;
}

/** N-10: whether a modal dialog is open (app shortcuts and terminals leave the keys to it). */
export function modalOpen(): boolean {
  return open.some((overlay) => overlay.kind === "dialog");
}
