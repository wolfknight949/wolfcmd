// N-03: paint a terminal's screen now, before the browser shows the frame.
//
// Changing a canvas's size clears it, and xterm paints again only at the next animation frame:
// the frame in between shows an empty terminal. That is the blink of a resize (the WebGL canvas
// is resized by `fit()`, again by xterm's device-pixel observer at a fractional scale, and
// replaced when a hidden terminal takes its WebGL context back). After each of those the view
// calls `paintNow`, which renders the visible rows at once through xterm's render service.
//
// xterm has no public "render now" (`refresh` waits for the next frame), so this reaches its
// render service; the names are checked, and without them it falls back to `refresh` (a
// one-frame blink, never an error). `pnpm e2e` (tests/e2e/src/resize.e2e.ts) catches a change.
import type { Terminal } from "@xterm/xterm";

/** The parts of xterm's render service (`term._core._renderService`) used here. */
interface RenderService {
  /** Renders rows `start`…`end` now (xterm's own frame callback calls it). */
  readonly _renderRows?: (start: number, end: number) => void;
  /** A resize that waited while the terminal was off screen. */
  readonly _pausedResizeTask?: { readonly flush?: () => void };
}

function renderService(term: Terminal): RenderService | undefined {
  return (term as unknown as { _core?: { _renderService?: RenderService } })._core?._renderService;
}

/**
 * Renders every visible row now. `true`: painted in this frame; `false`: only asked for the next
 * frame (xterm's internals changed).
 */
export function paintNow(term: Terminal): boolean {
  if (term.rows <= 0) return false;
  const service = renderService(term);
  const render = service?._renderRows;
  if (service === undefined || typeof render !== "function") {
    term.refresh(0, term.rows - 1);
    return false;
  }
  // A resize kept back while the terminal was off screen applies first (it clears the canvas).
  service._pausedResizeTask?.flush?.();
  render.call(service, 0, term.rows - 1);
  return true;
}
