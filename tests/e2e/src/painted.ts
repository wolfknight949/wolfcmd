// N-02: is what a WebGL terminal shows what its buffer holds? xterm's WebGL renderer keeps a model
// of the cells it drew and updates only the rows it is told changed; a row it isn't told about
// keeps its old pixels (stale text, or nothing) until something draws it again. `stalePaint`
// captures a terminal's rows, makes the renderer forget its model and draw every row from the
// buffer, captures them again and returns the rows that changed: the rows that were stale.
//
// The page has no handle on xterm's terminals, so `findTerminals` asks DevTools for the objects
// shaped like xterm's public `Terminal` (`Runtime.queryObjects`) and keeps them on the page
// (`window.__wcTerms`); the other helpers find a panel's terminal there.
import type { Page } from "playwright-core";

import { waitFrames } from "./frames";

/** Keeps every live xterm `Terminal` on the page; returns how many. Again after new panels. */
export async function findTerminals(page: Page): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const proto = await cdp.send("Runtime.evaluate", { expression: "Object.prototype" });
    const prototypeObjectId = proto.result.objectId;
    if (prototypeObjectId === undefined) throw new Error("no Object.prototype");
    const all = await cdp.send("Runtime.queryObjects", { prototypeObjectId });
    const objectId = all.objects.objectId;
    if (objectId === undefined) throw new Error("no objects");
    const found = await cdp.send("Runtime.callFunctionOn", {
      objectId,
      // Own properties only: no getter of an unrelated object runs.
      functionDeclaration: `function () {
        const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
        window.__wcTerms = this.filter((o) => o !== null && typeof o === "object" &&
          own(o, "_core") && own(o, "_addonManager"));
        return window.__wcTerms.length;
      }`,
      returnByValue: true,
    });
    await cdp.send("Runtime.releaseObject", { objectId });
    return found.result.value as number;
  } finally {
    await cdp.detach();
  }
}

/** The parts of xterm's `Terminal` (and its internals) the scenarios read. */
export interface PageTerminal {
  readonly element?: HTMLElement;
  readonly cols: number;
  readonly rows: number;
  readonly buffer: {
    readonly active: {
      readonly viewportY: number;
      readonly cursorY: number;
      getLine(y: number): { translateToString(trim: boolean): string } | undefined;
    };
  };
  refresh(start: number, end: number): void;
  readonly _core: { readonly _renderService: { _isPaused: boolean; clear(): void } };
}

/** Runs `body` in the page with the panel's terminal (`findTerminals` first). */
export async function withTerminal<A, R>(
  page: Page,
  panel: string,
  body: (term: PageTerminal, arg: A) => R,
  arg: A,
): Promise<Awaited<R>> {
  const result: unknown = await page.evaluate(
    ({ id, source, value }) => {
      const terms = (window as unknown as { __wcTerms?: PageTerminal[] }).__wcTerms ?? [];
      const term = terms.find((t) => t.element?.closest(`[data-panel="${id}"]`));
      if (term === undefined) throw new Error(`no terminal in panel ${id} (findTerminals first)`);
      // The body travels as its source, like page.evaluate's own function.
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const make = new Function(`return (${source})`) as () => (
        t: PageTerminal,
        a: unknown,
      ) => unknown;
      return make()(term, value);
    },
    { id: panel, source: body.toString(), value: arg },
  );
  return result as Awaited<R>;
}

/** The text of the rows a panel's terminal shows (its buffer, not its pixels). */
export async function bufferRows(page: Page, panel: string): Promise<string[]> {
  return withTerminal(
    page,
    panel,
    (term) => {
      const { active } = term.buffer;
      return Array.from(
        { length: term.rows },
        (_, y) => active.getLine(active.viewportY + y)?.translateToString(true) ?? "",
      );
    },
    undefined,
  );
}

/** The panel's terminal screen, one image per row. */
async function captureRows(page: Page, panel: string, rows: number): Promise<Buffer[]> {
  const box = await page.locator(`[data-panel="${panel}"] .xterm-screen`).boundingBox();
  if (box === null) throw new Error(`panel ${panel} has no screen`);
  const height = box.height / rows;
  const bands: Buffer[] = [];
  for (let y = 0; y < rows; y++) {
    bands.push(
      await page.screenshot({
        clip: { x: box.x, y: box.y + y * height + 1, width: box.width, height: height - 2 },
      }),
    );
  }
  return bands;
}

/**
 * The rows of a panel's terminal whose pixels change when the renderer draws every row afresh
 * from the buffer: rows that were painted stale. Empty when the screen was right. The cursor's
 * row is left out (its blink is drawing, not staleness). The terminal must hold still.
 */
export async function stalePaint(
  page: Page,
  panel: string,
  { release = false }: { readonly release?: boolean } = {},
): Promise<number[]> {
  const { rows, cursor } = await withTerminal(
    page,
    panel,
    (term) => ({ rows: term.rows, cursor: term.buffer.active.cursorY }),
    undefined,
  );
  const before = await captureRows(page, panel, rows);
  await withTerminal(
    page,
    panel,
    (term, letGo) => {
      // With `release`, the rendering held by `holdRendering` goes on in the same step, so no
      // routine refresh (a cursor blink) repaints the rows between the two captures.
      if (letGo) term._core._renderService._isPaused = false;
      // The renderer forgets what it drew (its model of the cells), then draws every row.
      term._core._renderService.clear();
      term.refresh(0, term.rows - 1);
    },
    release,
  );
  await waitFrames(page, 3);
  const after = await captureRows(page, panel, rows);
  return before.flatMap((band, y) => (y !== cursor && !band.equals(after[y] ?? band) ? [y] : []));
}

/** Holds or lets go of xterm's rendering (as it does itself while a terminal is off screen). */
export async function holdRendering(page: Page, panel: string, held: boolean): Promise<void> {
  await withTerminal(
    page,
    panel,
    (term, value) => {
      term._core._renderService._isPaused = value;
    },
    held,
  );
}
