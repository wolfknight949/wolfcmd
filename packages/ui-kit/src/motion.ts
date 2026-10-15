// N-01: motion helpers: the duration and easing tokens read for scripted animations (Web
// Animations on a ref, never per-frame React state), and the exit copy that lets something
// fade out after React removed it.
import { type RefObject, useLayoutEffect } from "react";

/** Pure: a CSS `<time>` ("167ms", "0.25s", "0s") in milliseconds; anything else is 0. */
export function parseDuration(value: string): number {
  const match = /^\s*(-?[\d.]+)(ms|s)\s*$/.exec(value);
  if (!match) return 0;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return match[2] === "s" ? n * 1000 : n;
}

/** A duration token (`dur-normal` → `--wc-dur-normal`) in ms: 0 under reduced motion or unread. */
export function durationToken(name: string, root: Element = document.documentElement): number {
  return parseDuration(getComputedStyle(root).getPropertyValue(`--wc-${name}`));
}

/** An easing token (`ease-out` → `--wc-ease-out`) for `element.animate`. */
export function easingToken(name: string, root: Element = document.documentElement): string {
  const value = getComputedStyle(root).getPropertyValue(`--wc-${name}`).trim();
  return value === "" ? "ease-out" : value;
}

/** A number token (`enter-scale` → `--wc-enter-scale`); `fallback` when unread. */
export function numberToken(
  name: string,
  fallback: number,
  root: Element = document.documentElement,
): number {
  const value = Number.parseFloat(getComputedStyle(root).getPropertyValue(`--wc-${name}`));
  return Number.isFinite(value) ? value : fallback;
}

/** Attributes a copy keeps (its look); every other `data-*`, role, name and id goes. */
const KEPT = new Set(["data-state", "data-side", "data-theme"]);

/** Pure: whether a copy drops this attribute (nothing finds it: no role, name, id or test hook). */
export function dropsAttribute(name: string): boolean {
  if (KEPT.has(name)) return false;
  return (
    name === "id" ||
    name === "role" ||
    name === "title" ||
    name === "name" ||
    name === "for" ||
    name === "tabindex" ||
    name === "autofocus" ||
    name.startsWith("aria-") ||
    name.startsWith("data-")
  );
}

function scrub(root: Element): void {
  for (const element of [root, ...root.querySelectorAll("*")]) {
    for (const { name } of [...element.attributes]) {
      if (dropsAttribute(name)) element.removeAttribute(name);
    }
  }
  root.setAttribute("aria-hidden", "true");
  root.setAttribute("inert", "");
}

export interface GhostPlace {
  readonly parent: Node;
  /** The sibling it goes before (`null`: at the end). */
  readonly before?: Node | null;
  /** `wc-leaving` (settles out) plus, for example, `wc-leaving-fade` (only fades). */
  readonly className?: string;
  /** Inline styles for the copy (where it stood, when its parent lays out the others). */
  readonly style?: Readonly<Record<string, string>>;
}

/**
 * N-01: fades out a copy of `element` (just removed, or about to be) at `place`: inert, hidden
 * from assistive tech and from tests (no roles, ids or `data-*` hooks), removed once its exit
 * ends. Nothing under reduced motion (`--wc-dur-fast` is 0). Returns the copy.
 */
export function leaveGhost(element: Element, place: GhostPlace): HTMLElement | undefined {
  const ms = durationToken("dur-fast");
  if (ms <= 0) return undefined;
  const ghost = element.cloneNode(true) as HTMLElement;
  scrub(ghost);
  ghost.classList.add("wc-leaving", ...(place.className ?? "").split(" ").filter(Boolean));
  for (const [key, value] of Object.entries(place.style ?? {})) ghost.style.setProperty(key, value);
  const before = place.before?.parentNode === place.parent ? place.before : null;
  place.parent.insertBefore(ghost, before);
  const remove = () => {
    ghost.remove();
  };
  ghost.addEventListener("animationend", (event) => {
    if (event.target === ghost) remove();
  });
  // In case its animation never runs (a hidden window): gone a little after it would have ended.
  window.setTimeout(remove, ms + 120);
  return ghost;
}

/**
 * N-01: when the element behind `ref` unmounts, a copy of it fades out where it was
 * (`leaveGhost`). A remount at once (StrictMode, a re-run) leaves no copy.
 */
export function useExitMotion(ref: RefObject<HTMLElement | null>, className = ""): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    return () => {
      const parent = element.parentNode;
      if (parent === null) return;
      const before = element.nextSibling;
      // After React's commit: the element is gone for good, its place still there.
      queueMicrotask(() => {
        if (element.isConnected || !parent.isConnected) return;
        leaveGhost(element, { parent, before, className });
      });
    };
  }, [ref, className]);
}
