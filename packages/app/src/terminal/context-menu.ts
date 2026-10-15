// N-03: what a right-click in a terminal does, and the terminal menu's own keys. Pure, tested.
//
// On Windows a right-click copies the selection or pastes, as in Windows Terminal and in VS
// Code's terminal on Windows (their default): the most frequent clipboard action stays one
// click, and Windows users' hands expect it. Shift+right-click opens the terminal's menu there.
// On macOS and Linux a right-click opens the menu (their convention). Shift+F10 and the Menu
// key always open it. A program that tracks the mouse (an agent's TUI, vim, htop) gets the
// right-click itself; Shift gives it back to WolfCmd (xterm doesn't report a Shift+click).
import { chordLetter } from "@wolfcmd/ui-kit";

/** What the right-click (or the keyboard's menu event) does. */
export type RightClick = "program" | "menu" | "quick";

export interface RightClickContext {
  /** It came from Shift+F10 or the Menu key. */
  readonly keyboard: boolean;
  readonly shiftKey: boolean;
  /** xterm's `modes.mouseTrackingMode` (`none`: the program doesn't want the mouse). */
  readonly tracking: string;
  /** A plain right-click copies or pastes (Windows). */
  readonly quick: boolean;
}

export function rightClickAction(context: RightClickContext): RightClick {
  if (context.keyboard || context.shiftKey) return "menu";
  if (context.tracking !== "none") return "program";
  return context.quick ? "quick" : "menu";
}

/** The terminal menu's keys besides copy, paste and find. */
export type EditKey = "selectAll" | "clear";

/** The parts of a key event the check reads. */
export interface EditKeyInfo {
  readonly type: string;
  readonly key: string;
  readonly code: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}

/**
 * Ctrl+Shift+A selects everything, Ctrl+Shift+K clears the scrollback (Cmd+Shift on macOS), by
 * letter (any layout, as Ctrl+Shift+F). Everything else stays the program's.
 */
export function editKey(event: EditKeyInfo, apple: boolean): EditKey | undefined {
  if (event.type !== "keydown" || event.altKey || !event.shiftKey) return undefined;
  const primary = apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!primary) return undefined;
  const letter = chordLetter(event);
  if (letter === "A") return "selectAll";
  if (letter === "K") return "clear";
  return undefined;
}
