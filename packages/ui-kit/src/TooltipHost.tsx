// One tooltip for the whole app. Elements keep using `title` (or
// `data-wc-tooltip` for a tooltip without the native attribute); the host shows our own
// tooltip instead of the browser's: after the pointer rests `--wc-delay-tooltip` (600 ms) on
// the element, or after keyboard focus lands on it. While the pointer is over an element, its
// `title` is held in `data-wc-title` (so the browser's own tooltip never shows) and put back
// when the pointer leaves.
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { parseDuration } from "./motion";
import { type TooltipRect, tooltipDelay, tooltipPlacement, tooltipText } from "./tooltip";

/** A tooltip without a native `title` (the host is the only one that shows it). */
const TOOLTIP_ATTRIBUTE = "data-wc-tooltip";
/** Where a hovered element's `title` waits while the host shows it. */
const HELD_ATTRIBUTE = "data-wc-title";
const SELECTOR = `[title], [${HELD_ATTRIBUTE}], [${TOOLTIP_ATTRIBUTE}]`;

/** Space kept from the window's edges, from the pointer or element, and under the cursor. */
const MARGIN = 8;
const GAP = 8;
const CURSOR = 20;
/** Used when the tokens can't be read (tests without CSS). */
const DEFAULT_DELAY = 600;
const DEFAULT_NEXT = 100;

export interface ShownTooltip {
  /** Changes with every tooltip, so each one fades in. */
  readonly serial: number;
  readonly text: string;
  readonly anchor: TooltipRect;
  readonly pointer: { readonly x: number; readonly y: number } | undefined;
}

function tokenDelay(doc: Document, name: string, fallback: number): number {
  const view = doc.defaultView;
  if (!view) return fallback;
  const value = parseDuration(view.getComputedStyle(doc.documentElement).getPropertyValue(name));
  return value > 0 ? value : fallback;
}

/** The element whose tooltip applies to `node` (the nearest one with a title). */
function tooltipTarget(node: EventTarget | null): Element | undefined {
  return node instanceof Element ? (node.closest(SELECTOR) ?? undefined) : undefined;
}

function textOf(element: Element): string | undefined {
  const title = element.getAttribute("title") ?? element.getAttribute(HELD_ATTRIBUTE);
  return tooltipText(title ?? element.getAttribute(TOOLTIP_ATTRIBUTE));
}

/** Moves `title` aside, so the browser's tooltip doesn't show over ours. */
function hold(element: Element) {
  const title = element.getAttribute("title");
  if (title === null) return;
  element.setAttribute(HELD_ATTRIBUTE, title);
  element.removeAttribute("title");
}

/** Puts `title` back (unless the element got a new one meanwhile). */
function release(element: Element) {
  const held = element.getAttribute(HELD_ATTRIBUTE);
  if (held === null) return;
  element.removeAttribute(HELD_ATTRIBUTE);
  if (!element.hasAttribute("title")) element.setAttribute("title", held);
}

/**
 * Follows the pointer and keyboard focus over `doc` and calls `show` with the tooltip to show
 * (`undefined`: none). Returns the stop function (it puts any held title back).
 */
function watchTooltips(
  doc: Document,
  show: (tooltip: ShownTooltip | undefined) => void,
): () => void {
  let hovered: Element | undefined;
  let target: Element | undefined;
  let held: Element | undefined;
  let pressed: Element | undefined;
  let pointer: { x: number; y: number } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let shown = false;
  let lastHidden: number | undefined;
  let keyboard = false;
  // A mouse button is held (a text selection or a drag in progress): no tooltip shows.
  let buttonsDown = false;
  // The tooltip is keyboard focus's: it stays until focus moves, whatever the pointer does.
  let fromFocus = false;
  let serial = 0;
  // Read once: the tokens don't change while the window lives (and reading them restyles).
  const delay = tokenDelay(doc, "--wc-delay-tooltip", DEFAULT_DELAY);
  const nextDelay = tokenDelay(doc, "--wc-delay-tooltip-next", DEFAULT_NEXT);

  const hide = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (!shown) return;
    shown = false;
    lastHidden = Date.now();
    show(undefined);
  };

  const schedule = (element: Element, byPointer: boolean) => {
    hide();
    target = element;
    fromFocus = !byPointer;
    const wait = tooltipDelay(Date.now(), lastHidden, delay, nextDelay);
    timer = setTimeout(() => {
      timer = undefined;
      const text = element.isConnected ? textOf(element) : undefined;
      if (text === undefined) return;
      const box = element.getBoundingClientRect();
      shown = true;
      serial += 1;
      show({
        serial,
        text,
        anchor: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
        pointer: byPointer ? pointer : undefined,
      });
    }, wait);
  };

  // The element under the pointer, or its title, changed.
  const follow = () => {
    const next = hovered === undefined ? undefined : tooltipTarget(hovered);
    if (held !== undefined && held !== next) release(held);
    held = next;
    if (next !== undefined) hold(next);
    if (next === target) return;
    if (next !== pressed) pressed = undefined;
    if (next === undefined || next === pressed || buttonsDown) {
      if (fromFocus) return;
      hide();
      target = next;
      return;
    }
    schedule(next, true);
  };

  const onPointerOver = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    pointer = { x: event.clientX, y: event.clientY };
    hovered = event.target instanceof Element ? event.target : undefined;
    buttonsDown = event.buttons > 0;
    follow();
  };
  const onPointerMove = (event: PointerEvent) => {
    if (timer !== undefined) pointer = { x: event.clientX, y: event.clientY };
  };
  const onPointerOut = (event: PointerEvent) => {
    // Leaving the window.
    if (event.relatedTarget !== null) return;
    hovered = undefined;
    follow();
  };
  // A press hides the tooltip, and it stays hidden until the pointer moves to something else.
  const onPointerDown = () => {
    keyboard = false;
    pressed = target;
    hide();
  };
  const onKeyDown = () => {
    keyboard = true;
    hide();
  };
  // Keyboard focus shows the focused element's own tooltip (not an ancestor's).
  const onFocusIn = (event: FocusEvent) => {
    const element = event.target instanceof Element ? event.target : undefined;
    if (!keyboard || !element?.matches(SELECTOR)) return;
    schedule(element, false);
  };
  const onFocusOut = (event: FocusEvent) => {
    if (!fromFocus || event.target !== target) return;
    hide();
    target = undefined;
    fromFocus = false;
  };

  // A title set while hovered (`Truncate` sets its own on pointer enter).
  const observer = new MutationObserver(() => {
    if (hovered !== undefined) follow();
  });
  observer.observe(doc.documentElement, {
    attributes: true,
    attributeFilter: ["title"],
    subtree: true,
  });

  const view = doc.defaultView;
  doc.addEventListener("pointerover", onPointerOver, true);
  doc.addEventListener("pointermove", onPointerMove, true);
  doc.addEventListener("pointerout", onPointerOut, true);
  doc.addEventListener("pointerdown", onPointerDown, true);
  doc.addEventListener("keydown", onKeyDown, true);
  doc.addEventListener("focusin", onFocusIn, true);
  doc.addEventListener("focusout", onFocusOut, true);
  doc.addEventListener("scroll", hide, true);
  doc.addEventListener("wheel", hide, { capture: true, passive: true });
  view?.addEventListener("blur", hide);
  view?.addEventListener("resize", hide);
  return () => {
    observer.disconnect();
    doc.removeEventListener("pointerover", onPointerOver, true);
    doc.removeEventListener("pointermove", onPointerMove, true);
    doc.removeEventListener("pointerout", onPointerOut, true);
    doc.removeEventListener("pointerdown", onPointerDown, true);
    doc.removeEventListener("keydown", onKeyDown, true);
    doc.removeEventListener("focusin", onFocusIn, true);
    doc.removeEventListener("focusout", onFocusOut, true);
    doc.removeEventListener("scroll", hide, true);
    doc.removeEventListener("wheel", hide, { capture: true });
    view?.removeEventListener("blur", hide);
    view?.removeEventListener("resize", hide);
    if (timer !== undefined) clearTimeout(timer);
    if (held !== undefined) release(held);
  };
}

/**
 * The app's one tooltip (mount it once, next to the app's root). It is `role="tooltip"`,
 * never takes the pointer, and sits inside the window: centered above the pointer, or above the
 * focused element, below when there is no room.
 */
export function TooltipHost() {
  const [tooltip, setTooltip] = useState<ShownTooltip>();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const stop = watchTooltips(document, (next) => {
      setTooltip(next);
    });
    return stop;
  }, []);
  // Placed once its size is known, before it paints (the DOM: an external system).
  useLayoutEffect(() => {
    const element = box.current;
    if (!element || !tooltip) return;
    const place = tooltipPlacement({
      anchor: tooltip.anchor,
      pointer: tooltip.pointer,
      size: { width: element.offsetWidth, height: element.offsetHeight },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      margin: MARGIN,
      gap: GAP,
      cursor: CURSOR,
    });
    element.style.left = `${String(place.left)}px`;
    element.style.top = `${String(place.top)}px`;
    element.dataset.side = place.side;
    element.style.visibility = "visible";
  }, [tooltip]);
  if (!tooltip) return null;
  return (
    <div
      key={tooltip.serial}
      ref={box}
      role="tooltip"
      className="wc-tooltip"
      style={{ left: 0, top: 0, visibility: "hidden" }}
    >
      {tooltip.text}
    </div>
  );
}
