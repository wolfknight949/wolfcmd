// N-01: the title bar moves the window itself instead of CSS `app-region: drag` (with app
// regions WebView2 recomputed its native drag regions on the window thread after every layout
// change, which stalled window moves). One listener on the document does what a native caption
// does for title bars (class `wc-drag`): press and drag moves the window (Aero Snap, drag to the
// top), a double press maximizes or restores, a right-click opens the system menu.
// Interactive elements inside (buttons, tabs, fields, `wc-no-drag`) keep their own clicks.

/**
 * Marks a title bar (a class, so wrappers that only pass `className` can carry it): presses on
 * its empty space move the window.
 */
export const DRAG_CLASS = "wc-drag";
/** Marks an element inside a title bar that keeps the mouse (a pill strip, a badge). */
export const NO_DRAG_CLASS = "wc-no-drag";

const INTERACTIVE = [
  "button",
  "a[href]",
  "input",
  "textarea",
  "select",
  "summary",
  "[contenteditable='']",
  "[contenteditable='true']",
  "[role='button']",
  "[role='tab']",
  "[role='menuitem']",
  "[role='option']",
  "[role='combobox']",
  "[role='slider']",
  "[role='textbox']",
  `.${NO_DRAG_CLASS}`,
].join(",");

/** Whether a press on `target` belongs to the window (a title bar's empty space). Pure. */
export function isDragTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const bar = target.closest(`.${DRAG_CLASS}`);
  if (bar === null) return false;
  const control = target.closest(INTERACTIVE);
  // A control outside the bar (the bar inside a button) doesn't count.
  return control === null || !bar.contains(control);
}

/** What the title bar asks the window to do (Tauri's window API and the core's menu). */
export interface WindowHost {
  readonly startDragging: () => Promise<void>;
  readonly toggleMaximize: () => Promise<void>;
  /** The system menu at a point in CSS pixels of the client area. */
  readonly systemMenu: (x: number, y: number) => Promise<void>;
}

/** Installs the listeners on `root` (the document); returns how to remove them. */
export function installWindowDrag(root: Document, host: WindowHost): () => void {
  const report = (promise: Promise<void>) => {
    promise.catch((error: unknown) => {
      console.warn("window drag", error);
    });
  };
  const onPress = (event: MouseEvent) => {
    if (event.button !== 0 || !isDragTarget(event.target)) return;
    event.preventDefault();
    // The second press of a double press arrives before the drag loop would start again.
    report(event.detail === 2 ? host.toggleMaximize() : host.startDragging());
  };
  const onMenu = (event: MouseEvent) => {
    if (!isDragTarget(event.target)) return;
    event.preventDefault();
    report(host.systemMenu(event.clientX, event.clientY));
  };
  root.addEventListener("mousedown", onPress);
  root.addEventListener("contextmenu", onMenu);
  return () => {
    root.removeEventListener("mousedown", onPress);
    root.removeEventListener("contextmenu", onMenu);
  };
}
