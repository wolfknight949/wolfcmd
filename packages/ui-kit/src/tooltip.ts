// Where the tooltip goes and how long it waits (pure). `TooltipHost` uses them.

export interface TooltipRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface TooltipPlacementInput {
  /** The element the tooltip is about (viewport px). */
  readonly anchor: TooltipRect;
  /** The pointer, when the mouse asked for the tooltip; keyboard focus has none. */
  readonly pointer?: { readonly x: number; readonly y: number } | undefined;
  readonly size: { readonly width: number; readonly height: number };
  readonly viewport: { readonly width: number; readonly height: number };
  /** Space kept at the window's edges. */
  readonly margin: number;
  /** Space between the tooltip and the pointer or the element. */
  readonly gap: number;
  /** How far the cursor reaches below the pointer (a tooltip below the pointer clears it). */
  readonly cursor: number;
}

export interface TooltipPlacement {
  readonly left: number;
  readonly top: number;
  readonly side: "top" | "bottom";
}

/**
 * Pure: centered above the pointer (mouse) or above the element (keyboard focus),
 * below them when there is no room above, and always inside the window.
 */
export function tooltipPlacement(input: TooltipPlacementInput): TooltipPlacement {
  const { anchor, pointer, size, viewport, margin, gap } = input;
  const centerX = pointer ? pointer.x : (anchor.left + anchor.right) / 2;
  const above = (pointer ? pointer.y : anchor.top) - gap - size.height;
  const below = (pointer ? pointer.y + input.cursor : anchor.bottom) + gap;
  const side = above >= margin ? "top" : "bottom";
  const wanted = side === "top" ? above : below;
  const maxLeft = viewport.width - size.width - margin;
  const maxTop = viewport.height - size.height - margin;
  return {
    left: Math.max(margin, Math.min(centerX - size.width / 2, maxLeft)),
    top: Math.max(margin, Math.min(wanted, maxTop)),
    side,
  };
}

/**
 * Pure: how long to wait before showing a tooltip: `next` (short) while moving on from one that
 * hid less than `delay` ago, like Windows; else `delay`.
 */
export function tooltipDelay(
  now: number,
  lastHidden: number | undefined,
  delay: number,
  next: number,
): number {
  return lastHidden !== undefined && now - lastHidden < delay ? Math.min(next, delay) : delay;
}

/** Pure: the text a `title` shows; blank (an explicit "no tooltip here") is none. */
export function tooltipText(value: string | null): string | undefined {
  const text = value?.trim();
  return text === undefined || text === "" ? undefined : text;
}
