// Selecting an agent's output lagged while the agent worked.
// Claude Code's full-screen renderer turns on mouse tracking (all motion, SGR), so a drag in its
// panel is sent to the agent and the agent draws the selection itself. While it works its event
// loop is busy and the selection crawls behind the pointer. In an agent panel WolfCmd keeps the
// drag: a press is held until it either moves (a drag: xterm selects, at once) or is released
// (a click: replayed to the agent unchanged). The wheel, other buttons and Alt+drag still go to
// the program.

/** How far (CSS px) a held press must move to count as a drag. */
export const DRAG_THRESHOLD_PX = 4;

/** What the terminal knows when the left button goes down. */
export interface PressContext {
  /** The panel runs an agent (`args.agent`, or one found running in it). */
  readonly agentPanel: boolean;
  /** xterm's `modes.mouseTrackingMode`: `none` when the program doesn't want the mouse. */
  readonly tracking: string;
}

/** The parts of a mouse event the decision reads. */
export interface Press {
  readonly button: number;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  /** A real press (not one WolfCmd replays). */
  readonly isTrusted: boolean;
}

/**
 * Whether WolfCmd holds this press to see if it becomes a drag. Only the left button, in
 * an agent panel whose program tracks the mouse; Shift already selects in xterm and Alt gives
 * the drag to the program.
 */
export function holdsPress(press: Press, context: PressContext): boolean {
  return (
    press.isTrusted &&
    press.button === 0 &&
    !press.shiftKey &&
    !press.altKey &&
    context.agentPanel &&
    context.tracking !== "none"
  );
}

/** A held press that moved this far is a drag. */
export function isDrag(
  from: { readonly x: number; readonly y: number },
  to: { readonly x: number; readonly y: number },
  threshold = DRAG_THRESHOLD_PX,
): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) >= threshold;
}

/**
 * The init of a replayed mouse event: the held press's position and keys, as `type`; `select`
 * adds Shift, which makes xterm select instead of reporting the mouse to the program.
 */
export function replayInit(event: MouseEvent, select: boolean): MouseEventInit {
  return {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: event.view,
    detail: event.detail,
    screenX: event.screenX,
    screenY: event.screenY,
    clientX: event.clientX,
    clientY: event.clientY,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    shiftKey: select || event.shiftKey,
    button: event.button,
    buttons: event.buttons,
  };
}
