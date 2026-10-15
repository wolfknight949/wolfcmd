// N-03: context menus from the keyboard. Shift+F10 and the Menu key open the menu of the focused
// object: the app catches the key (before the terminal or a menu sees it) and sends that object
// the same `contextmenu` event a right-click would, marked as the keyboard's, at the object's
// own place. The browser's own event for these keys is suppressed, so it never arrives twice.

/** What the key check reads (a DOM `KeyboardEvent`). */
export interface ContextKeyInfo {
  readonly type: string;
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}

/** Shift+F10 or the Menu key (no other modifier): the keyboard's "open the context menu". */
export function isContextMenuKey(event: ContextKeyInfo): boolean {
  if (event.ctrlKey || event.altKey || event.metaKey) return false;
  return event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);
}

const fromKeyboard = new WeakSet<Event>();

/**
 * Sends `target` a `contextmenu` event as the keyboard's menu keys would, at its bottom left
 * (under a terminal's cursor, under a menu row). Returns whether something took it.
 */
export function openContextMenuFrom(target: Element): boolean {
  const box = target.getBoundingClientRect();
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    button: 2,
    clientX: box.left,
    clientY: box.bottom,
  });
  fromKeyboard.add(event);
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

/** Whether a `contextmenu` event came from the keyboard (`openContextMenuFrom`). */
export function isKeyboardMenu(event: Event): boolean {
  return fromKeyboard.has(event);
}
