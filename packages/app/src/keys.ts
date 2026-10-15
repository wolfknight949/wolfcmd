// N-03: the keyboard shortcuts (tabs: Ctrl+Shift+T, Ctrl+Shift+D duplicate, Ctrl+Tab,
// Ctrl+Alt+1…9; panels: Alt+Shift+=/-, Alt+arrows, Ctrl+Shift+W, Ctrl+Shift+Enter maximize;
// Ctrl+Shift+N new workspace; Ctrl+=/- font; N-07 Ctrl+, Settings; N-01 Ctrl+Q quits; N-11
// Ctrl+Shift+Z undo, Ctrl+Shift+Y redo; Shift+F10 and the Menu key: the focused object's context
// menu). Capture phase, so they work while a terminal has the keyboard; every other key goes to
// the terminal untouched. Cmd on macOS where these say Ctrl+Shift (`primaryModifier`).
import {
  chordLetter,
  isApple,
  isContextMenuKey,
  isImeKey,
  modalOpen,
  openContextMenuFrom,
  primaryModifier,
} from "@wolfcmd/ui-kit";

import type { Actions } from "./actions";
import { openSettings } from "./chrome/settings-open";
import type { Arrow } from "./model/layout";

export interface KeyHost {
  readonly actions: Actions;
  /** The shown workspace's focused panel, if any. */
  readonly focusedPanel: () => string | undefined;
  /** N-03: the shown tab. */
  readonly shownTab: () => string | undefined;
  readonly focusNeighbor: (arrow: Arrow) => void;
}

const ARROWS: Readonly<Partial<Record<string, Arrow>>> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

const APPLE = isApple();

const plus = (code: string) => code === "Equal" || code === "NumpadAdd";
const minus = (code: string) => code === "Minus" || code === "NumpadSubtract";

/** What a key does, or `undefined` when it is not a shortcut (then it goes to the terminal). */
export function shortcutFor(event: KeyboardEvent, host: KeyHost): (() => void) | undefined {
  // N-10: a dialog keeps the keyboard.
  if (event.type !== "keydown" || isImeKey(event) || modalOpen()) return undefined;
  const { ctrlKey: ctrl, shiftKey: shift, altKey: alt, code } = event;
  const { actions } = host;
  const letter = chordLetter(event);
  const primary = primaryModifier(event, APPLE);
  // N-07: Settings (Cmd+, on macOS); the focus comes back to what had it.
  if (primary && !shift && !alt && (code === "Comma" || event.key === ",")) {
    return () => {
      const active = document.activeElement;
      openSettings(active instanceof HTMLElement ? active : null);
    };
  }
  // N-01: quit for real (Cmd+Q on macOS), the way out besides the tray's menu: closing the
  // window only hides it to the tray.
  if (primary && !shift && !alt && letter === "Q") {
    return () => {
      actions.quit();
    };
  }
  // N-03: the focused panel fills its tab, or the tab shows its tiles again.
  if (primary && shift && !alt && event.key === "Enter") {
    const panel = host.focusedPanel();
    return panel === undefined
      ? undefined
      : () => {
          actions.toggleMaximize(panel);
        };
  }
  // N-03: a copy of the shown tab (fresh shells and agents).
  if (primary && shift && !alt && letter === "D") {
    const tab = host.shownTab();
    return tab === undefined
      ? undefined
      : () => {
          actions.duplicateTab(tab);
        };
  }
  // N-11: undo and redo of layout and workspace changes. Never Ctrl+Z / Ctrl+Y: those are the
  // terminal's (Ctrl+Z suspends a job in a shell; editors in a terminal undo with them).
  if (primary && shift && !alt && (letter === "Z" || letter === "Y")) {
    const undo = letter === "Z";
    return () => {
      if (undo) actions.undo();
      else actions.redo();
    };
  }
  if (ctrl && !alt && event.key === "Tab") {
    return () => {
      actions.cycleTab(shift ? -1 : 1);
    };
  }
  if (ctrl && shift && !alt && letter === "T") {
    return () => {
      actions.newTab();
    };
  }
  if (ctrl && shift && !alt && letter === "N") {
    return () => {
      actions.newWorkspace();
    };
  }
  if (ctrl && shift && !alt && letter === "W") {
    const panel = host.focusedPanel();
    return panel === undefined
      ? undefined
      : () => {
          actions.closePanel(panel);
        };
  }
  if (alt && shift && !ctrl && (plus(code) || minus(code))) {
    const side = plus(code) ? "right" : "down";
    return () => {
      actions.newTerminal(side);
    };
  }
  const arrow = ARROWS[event.key];
  if (alt && !ctrl && !shift && arrow !== undefined) {
    return () => {
      host.focusNeighbor(arrow);
    };
  }
  if (ctrl && alt && !shift && /^Digit[1-9]$/.test(code)) {
    const n = Number(code.slice(5));
    return () => {
      actions.activateTabNumber(n);
    };
  }
  if (ctrl && !alt && !shift && (plus(code) || minus(code))) {
    const step = plus(code) ? 1 : -1;
    return () => {
      actions.fontSize(step);
    };
  }
  return undefined;
}

/**
 * N-03: Shift+F10 and the Menu key open the focused object's context menu (a terminal's, a menu
 * row's, a tab pill's): it gets the `contextmenu` event a right-click would, marked as the
 * keyboard's. The browser's own event for these keys is suppressed (it would arrive as a
 * right-click: a terminal would paste). Nothing focused (the page itself): no menu.
 */
function onContextKey(event: KeyboardEvent, target: Document): boolean {
  if (!isContextMenuKey(event) || modalOpen()) return false;
  event.preventDefault();
  event.stopPropagation();
  const focused = target.activeElement;
  if (event.type === "keydown" && focused !== null && focused !== target.body) {
    openContextMenuFrom(focused);
  }
  return true;
}

/** Installs the shortcuts on `target` (the window); returns how to remove them. */
export function installKeys(target: Window, host: KeyHost): () => void {
  const onKey = (event: KeyboardEvent) => {
    if (onContextKey(event, target.document)) return;
    const run = shortcutFor(event, host);
    if (run === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    run();
  };
  // The Menu key's own `contextmenu` comes after its keyup on Windows.
  const onKeyUp = (event: KeyboardEvent) => {
    onContextKey(event, target.document);
  };
  target.addEventListener("keydown", onKey, { capture: true });
  target.addEventListener("keyup", onKeyUp, { capture: true });
  return () => {
    target.removeEventListener("keydown", onKey, { capture: true });
    target.removeEventListener("keyup", onKeyUp, { capture: true });
  };
}
