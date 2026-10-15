// N-03: where a dragged panel or tab pill would land, as pure functions on rectangles. The drag
// itself never needs React (one paint per frame, through refs), and all of it is unit-tested.
import type { Edge, Rect } from "./layout";

/** Pixels the pointer must travel before a press becomes a drag (a click stays a click). */
const DRAG_THRESHOLD = 4;
/** Within this fraction of a panel's size from an edge, a drop splits on that side. */
const EDGE = 0.25;

/** A drop zone of a panel: one of its sides (split there) or its centre (swap with it). */
export type Zone = Edge | "center";

export interface DropTarget {
  readonly panelId: string;
  readonly zone: Zone;
}

/** Whether a press that moved by (dx, dy) is a drag yet. */
export function pastThreshold(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) >= DRAG_THRESHOLD;
}

const inside = (r: Rect, x: number, y: number) =>
  x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;

/** The zone of `rect` under (x, y): the nearest edge within a quarter of the size, else the centre. */
export function zoneAt(rect: Rect, x: number, y: number): Zone {
  const fx = (x - rect.x) / rect.width;
  const fy = (y - rect.y) / rect.height;
  const edges: [Zone, number][] = [
    ["left", fx],
    ["right", 1 - fx],
    ["up", fy],
    ["down", 1 - fy],
  ];
  const [zone, distance] = edges.reduce((best, edge) => (edge[1] < best[1] ? edge : best));
  return distance < EDGE ? zone : "center";
}

/**
 * The drop target under (x, y) among `panels` (in the same coordinates as the point). The
 * dragged panel itself is no target.
 */
export function dropTargetAt(
  x: number,
  y: number,
  dragged: string,
  panels: ReadonlyMap<string, Rect>,
): DropTarget | undefined {
  for (const [panelId, rect] of panels) {
    if (panelId === dragged || !inside(rect, x, y)) continue;
    return { panelId, zone: zoneAt(rect, x, y) };
  }
  return undefined;
}

export function sameTarget(a: DropTarget | undefined, b: DropTarget | undefined): boolean {
  return a?.panelId === b?.panelId && a?.zone === b?.zone;
}

/** The part of a panel the drop preview covers: the half on that side, or all of it. */
export function zoneRect(rect: Rect, zone: Zone): Rect {
  const halfW = rect.width / 2;
  const halfH = rect.height / 2;
  switch (zone) {
    case "left":
      return { ...rect, width: halfW };
    case "right":
      return { ...rect, x: rect.x + halfW, width: halfW };
    case "up":
      return { ...rect, height: halfH };
    case "down":
      return { ...rect, y: rect.y + halfH, height: halfH };
    case "center":
      return rect;
  }
}

/**
 * N-03: the index a dragged tab pill lands at (as `moveTab` counts: among the other tabs): the
 * number of other pills whose centres are left of the dragged pill's centre.
 */
export function tabIndexAt(x: number, centers: readonly number[]): number {
  return centers.filter((center) => center < x).length;
}

/**
 * How far each pill slides while the pill at `from` is dragged to slot `index` (the dragged
 * one's own entry is 0: it follows the pointer). Pills between the two slots make room by the
 * dragged pill's width.
 */
export function tabShifts(count: number, from: number, index: number, width: number): number[] {
  return Array.from({ length: count }, (_, i) => {
    if (i === from) return 0;
    if (index > from && i > from && i <= index) return -width;
    if (index < from && i >= index && i < from) return width;
    return 0;
  });
}

/** A horizontal extent (no transforms). */
export interface Span {
  readonly left: number;
  readonly width: number;
}

/** Keeps a dragged pill (offset `dx`) inside its strip, so it can't be dragged away. */
export function clampTabOffset(dx: number, tab: Span, strip: Span): number {
  const min = strip.left - tab.left;
  const max = strip.left + strip.width - (tab.left + tab.width);
  return Math.min(Math.max(dx, Math.min(min, 0)), Math.max(max, 0));
}
