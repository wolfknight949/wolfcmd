import type { Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";

import { paintNow } from "./paint";

/** A terminal shaped like xterm's, with the render service `paintNow` reaches. */
function fakeTerm(service: object | undefined, rows = 24) {
  const refresh = vi.fn();
  const term = { rows, refresh, _core: service === undefined ? {} : { _renderService: service } };
  return { term: term as unknown as Terminal, refresh };
}

describe("N-03 a resized terminal is painted in the same frame", () => {
  it("N-03 renders every visible row at once through the render service", () => {
    const renderRows = vi.fn();
    const { term, refresh } = fakeTerm({ _renderRows: renderRows });
    expect(paintNow(term)).toBe(true);
    expect(renderRows).toHaveBeenCalledExactlyOnceWith(0, 23);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("N-03 applies a resize kept back while off screen before it renders", () => {
    const order: string[] = [];
    const service = {
      _renderRows: () => order.push("render"),
      _pausedResizeTask: { flush: () => order.push("resize") },
    };
    paintNow(fakeTerm(service).term);
    expect(order).toEqual(["resize", "render"]);
  });

  it("N-03 falls back to the next frame when xterm's internals changed", () => {
    const { term, refresh } = fakeTerm(undefined);
    expect(paintNow(term)).toBe(false);
    expect(refresh).toHaveBeenCalledExactlyOnceWith(0, 23);
  });

  it("N-03 does nothing for a terminal without rows", () => {
    const renderRows = vi.fn();
    const { term, refresh } = fakeTerm({ _renderRows: renderRows }, 0);
    expect(paintNow(term)).toBe(false);
    expect(renderRows).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});
