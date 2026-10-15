// N-03: the layout of a tab, as pure functions: splits whose leaves are panels (the Wave
// model). Every change returns a new tree (the store saves it); the core
// checks the same rules again when it saves (`Document::normalized`).
import type { Direction, Layout, Panel } from "@wolfcmd/bindings";

type Split = Extract<Layout, { kind: "split" }>;
export type PanelLeaf = Extract<Layout, { kind: "panel" }>;

/** The smallest share a split gives one child (`wcmd_state::MIN_RATIO`). */
export const MIN_RATIO = 0.05;

/** Where a new panel goes next to an existing one. */
export type Side = "right" | "down";

/** A layout of one panel. */
export function leaf(panel: Panel): PanelLeaf {
  return { kind: "panel", ...panel };
}

/** Every panel, in reading order. */
export function panelsOf(layout: Layout): PanelLeaf[] {
  return layout.kind === "panel" ? [layout] : layout.children.flatMap(panelsOf);
}

export function hasPanel(layout: Layout, panelId: string): boolean {
  return panelsOf(layout).some((panel) => panel.id === panelId);
}

/** `layout` with every node passed through `visit` (bottom up). */
function mapLayout(layout: Layout, visit: (node: Layout) => Layout): Layout {
  if (layout.kind === "panel") return visit(layout);
  return visit({ ...layout, children: layout.children.map((child) => mapLayout(child, visit)) });
}

/** Panel `panelId` changed by `change` (its cwd, title or agent). */
export function updatePanel(
  layout: Layout,
  panelId: string,
  change: (panel: PanelLeaf) => PanelLeaf,
): Layout {
  return mapLayout(layout, (node) =>
    node.kind === "panel" && node.id === panelId ? change(node) : node,
  );
}

/**
 * `panel` next to `targetId`, sharing its space. In a split of the same direction it becomes a
 * sibling (the target's share is halved); otherwise the target becomes a split of the two.
 */
export function splitPanel(
  layout: Layout,
  targetId: string,
  side: Side,
  panel: Panel,
  newSplitId: string,
): Layout {
  return insertPanel(layout, targetId, side, leaf(panel), newSplitId);
}

/** N-03: a side of a panel a dragged one can land on. */
export type Edge = "left" | "right" | "up" | "down";

/**
 * `fresh` on `edge` of `targetId`, sharing its space: before it (left, up) or after it (right,
 * down). In a split of that direction it becomes a sibling (the target's share is halved);
 * otherwise the target becomes a split of the two.
 */
export function insertPanel(
  layout: Layout,
  targetId: string,
  edge: Edge,
  fresh: PanelLeaf,
  newSplitId: string,
): Layout {
  const direction: Direction = edge === "left" || edge === "right" ? "row" : "column";
  const after = edge === "right" || edge === "down";
  const isTarget = (node: Layout) => node.kind === "panel" && node.id === targetId;
  const walk = (node: Layout): Layout => {
    if (isTarget(node)) {
      return {
        kind: "split",
        id: newSplitId,
        direction,
        children: after ? [node, fresh] : [fresh, node],
        ratios: [0.5, 0.5],
      };
    }
    if (node.kind === "panel") return node;
    const index = node.children.findIndex(isTarget);
    if (index >= 0 && node.direction === direction) {
      const ratios = shares(node);
      const half = (ratios[index] ?? 0) / 2;
      ratios.splice(index, 1, half, half);
      const children = [...node.children];
      children.splice(after ? index + 1 : index, 0, fresh);
      return { ...node, children, ratios };
    }
    return { ...node, children: node.children.map(walk) };
  };
  return walk(layout);
}

/** The panel `panelId`, if the layout has it. */
export function findPanel(layout: Layout, panelId: string): PanelLeaf | undefined {
  return panelsOf(layout).find((panel) => panel.id === panelId);
}

/**
 * N-03: panel `panelId` moved to `edge` of `targetId` (a drag onto a drop zone). The panel
 * keeps its ID and everything in it, so its card and its terminal stay mounted. The same
 * layout when there is nothing to move (the panel onto itself, a missing one).
 */
export function movePanel(
  layout: Layout,
  panelId: string,
  targetId: string,
  edge: Edge,
  newSplitId: string,
): Layout {
  const moving = findPanel(layout, panelId);
  if (moving === undefined || panelId === targetId || !hasPanel(layout, targetId)) return layout;
  const rest = removePanel(layout, panelId);
  if (rest === undefined) return layout;
  return insertPanel(rest, targetId, edge, moving, newSplitId);
}

/** N-03: panels `a` and `b` trade places (a drag onto a panel's centre). */
export function swapPanels(layout: Layout, a: string, b: string): Layout {
  const first = findPanel(layout, a);
  const second = findPanel(layout, b);
  if (first === undefined || second === undefined || a === b) return layout;
  return mapLayout(layout, (node) =>
    node.kind !== "panel" ? node : node.id === a ? second : node.id === b ? first : node,
  );
}

/**
 * `layout` without `panelId`; `undefined` when nothing is left. A split left with one child is
 * replaced by it, and the others share the freed space.
 */
export function removePanel(layout: Layout, panelId: string): Layout | undefined {
  if (layout.kind === "panel") return layout.id === panelId ? undefined : layout;
  const children: Layout[] = [];
  const kept: number[] = [];
  const ratios = shares(layout);
  layout.children.forEach((child, index) => {
    const next = removePanel(child, panelId);
    if (next !== undefined) {
      children.push(next);
      kept.push(ratios[index] ?? 0);
    }
  });
  if (children.length === 0) return undefined;
  if (children.length === 1) return children[0];
  return { ...layout, children, ratios: normalized(kept) };
}

/** The split `splitId` with new shares (each at least `MIN_RATIO`, summing to 1). */
export function setRatios(layout: Layout, splitId: string, ratios: readonly number[]): Layout {
  return mapLayout(layout, (node) =>
    node.kind === "split" && node.id === splitId && ratios.length === node.children.length
      ? { ...node, ratios: normalized(ratios) }
      : node,
  );
}

/** A split's shares as numbers (a missing or broken one counts as an equal share). */
export function shares(split: Split): number[] {
  const equal = 1 / split.children.length;
  return split.children.map((_, i) => {
    const value = split.ratios[i];
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : equal;
  });
}

/** Shares that are at least `MIN_RATIO` each and sum to 1. */
export function normalized(ratios: readonly number[]): number[] {
  const usable = ratios.length > 0 && ratios.every((r) => Number.isFinite(r) && r > 0);
  const raw = usable ? ratios : ratios.map(() => 1);
  const total = raw.reduce((sum, r) => sum + r, 0);
  const clamped = raw.map((r) => Math.max(r / total, MIN_RATIO));
  const clampedTotal = clamped.reduce((sum, r) => sum + r, 0);
  return clamped.map((r) => r / clampedTotal);
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A draggable line between two children of a split. */
export interface Divider {
  readonly splitId: string;
  /** The child before the line (its index in the split). */
  readonly index: number;
  readonly direction: Direction;
  /** The line's box (`gap` wide). */
  readonly rect: Rect;
  /** The split's box, to turn a pointer position into shares. */
  readonly area: Rect;
}

export interface Geometry {
  /** Each panel's box. */
  readonly panels: ReadonlyMap<string, Rect>;
  readonly dividers: readonly Divider[];
}

/** Where every panel and divider is in `area`, with `gap` pixels between children. */
export function geometry(layout: Layout, area: Rect, gap: number): Geometry {
  const panels = new Map<string, Rect>();
  const dividers: Divider[] = [];
  const place = (node: Layout, box: Rect) => {
    if (node.kind === "panel") {
      panels.set(node.id, box);
      return;
    }
    const row = node.direction === "row";
    const total = row ? box.width : box.height;
    const usable = Math.max(0, total - gap * (node.children.length - 1));
    const ratios = shares(node);
    let offset = row ? box.x : box.y;
    node.children.forEach((child, index) => {
      const size = usable * (ratios[index] ?? 0);
      const rect = row
        ? { x: offset, y: box.y, width: size, height: box.height }
        : { x: box.x, y: offset, width: box.width, height: size };
      place(child, rect);
      offset += size;
      if (index < node.children.length - 1) {
        dividers.push({
          splitId: node.id,
          index,
          direction: node.direction,
          rect: row
            ? { x: offset, y: box.y, width: gap, height: box.height }
            : { x: box.x, y: offset, width: box.width, height: gap },
          area: box,
        });
        offset += gap;
      }
    });
  };
  place(layout, area);
  return { panels, dividers };
}

/**
 * The shares after dragging `divider` to `position` (pixels along the split), keeping every
 * child at least `MIN_RATIO`. `current` is the split's shares before the drag.
 */
export function dragRatios(
  current: readonly number[],
  divider: Divider,
  position: number,
  gap: number,
): number[] {
  const row = divider.direction === "row";
  const start = row ? divider.area.x : divider.area.y;
  const total = (row ? divider.area.width : divider.area.height) - gap * (current.length - 1);
  if (total <= 0) return [...current];
  const before = current.slice(0, divider.index).reduce((sum, r) => sum + r, 0);
  const pair = (current[divider.index] ?? 0) + (current[divider.index + 1] ?? 0);
  const pointer = (position - start - gap * divider.index - gap / 2) / total;
  const first = Math.min(Math.max(pointer - before, MIN_RATIO), pair - MIN_RATIO);
  const next = [...current];
  next[divider.index] = first;
  next[divider.index + 1] = pair - first;
  return next;
}

/** The split `splitId`, if the layout has it. */
export function findSplit(layout: Layout, splitId: string): Split | undefined {
  if (layout.kind === "panel") return undefined;
  if (layout.id === splitId) return layout;
  for (const child of layout.children) {
    const found = findSplit(child, splitId);
    if (found !== undefined) return found;
  }
  return undefined;
}

export type Arrow = "left" | "right" | "up" | "down";

/**
 * The panel next to `fromId` in `arrow`'s direction: the nearest one whose box lies that way and
 * overlaps on the other axis.
 */
export function neighbor(
  boxes: ReadonlyMap<string, Rect>,
  fromId: string,
  arrow: Arrow,
): string | undefined {
  const from = boxes.get(fromId);
  if (from === undefined) return undefined;
  const horizontal = arrow === "left" || arrow === "right";
  let best: { id: string; distance: number } | undefined;
  for (const [id, box] of boxes) {
    if (id === fromId) continue;
    const overlaps = horizontal
      ? box.y < from.y + from.height && from.y < box.y + box.height
      : box.x < from.x + from.width && from.x < box.x + box.width;
    if (!overlaps) continue;
    const distance =
      arrow === "left"
        ? from.x - (box.x + box.width)
        : arrow === "right"
          ? box.x - (from.x + from.width)
          : arrow === "up"
            ? from.y - (box.y + box.height)
            : box.y - (from.y + from.height);
    if (distance < -1) continue;
    if (best === undefined || distance < best.distance) best = { id, distance };
  }
  return best?.id;
}
