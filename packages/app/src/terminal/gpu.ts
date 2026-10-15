// N-02: the WebGL renderer only while the terminal is on screen. Chromium keeps about 16 WebGL
// contexts per page and drops the oldest beyond that, and a hidden terminal still drew every
// frame of output. A hidden terminal gives its context back (xterm then keeps its state with the
// DOM renderer, paused while off screen) and takes a new one when it is shown again.
//
// N-03: a new or resized canvas is empty until it is drawn. `show` paints the new canvas before
// the frame is shown, and a size change of the canvas (xterm's device-pixel observer at a
// fractional scale, after `fit()`) is painted in the same frame by `onCanvasResize`.
//
// A context lost while the terminal is shown (the browser dropped it, the GPU reset) is asked
// for again on the next frame, a few times at most before the DOM renderer stays.
import { WebglAddon } from "@xterm/addon-webgl";
import type { Terminal } from "@xterm/xterm";

import { paintNow } from "./paint";

/** New contexts asked for after losses while shown (counted again once it is hidden). */
const RETRIES = 3;

export interface Gpu {
  /** Renders with WebGL (the DOM renderer if WebGL is unavailable), painted at once. */
  show(): void;
  /** Releases the WebGL context. */
  hide(): void;
  /**
   * The terminal goes: `disposeTerminal` disposes it, then the context is given back (without
   * switching to the DOM renderer first, as `hide` does).
   */
  dispose(disposeTerminal: () => void): void;
}

export function createGpu(term: Terminal, host: HTMLElement): Gpu {
  let addon: WebglAddon | undefined;
  let canvases: HTMLCanvasElement[] = [];
  let watcher: ResizeObserver | undefined;
  /** The terminal is shown (`show` without a `hide` since). */
  let wanted = false;
  let retries = 0;
  let retryFrame = 0;
  /** Lets go of the addon; returns what gives its contexts back (after the addon is gone). */
  const release = (): (() => void) => {
    const loaded = addon;
    if (loaded === undefined) return () => undefined;
    addon = undefined;
    watcher?.disconnect();
    watcher = undefined;
    // The addon removes its canvas but leaves the context to garbage collection: give it back.
    const contexts = canvases.map((canvas) => canvas.getContext("webgl2"));
    canvases = [];
    return () => {
      for (const gl of contexts) gl?.getExtension("WEBGL_lose_context")?.loseContext();
    };
  };
  const drop = () => {
    const loaded = addon;
    const giveBack = release();
    loaded?.dispose();
    giveBack();
  };
  const show = () => {
    wanted = true;
    if (addon !== undefined) return;
    try {
      const before = new Set(host.querySelectorAll("canvas"));
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        if (addon !== webgl) return;
        drop();
        if (!wanted || retries >= RETRIES || retryFrame !== 0) return;
        retries += 1;
        retryFrame = requestAnimationFrame(() => {
          retryFrame = 0;
          if (wanted) show();
        });
      });
      term.loadAddon(webgl);
      addon = webgl;
      canvases = [...host.querySelectorAll("canvas")].filter((canvas) => !before.has(canvas));
    } catch (error) {
      console.warn("WebGL renderer unavailable; using the DOM renderer", error);
    }
    // N-03: the new canvas (or the DOM renderer's new rows) is drawn before this frame shows.
    paintNow(term);
    // xterm's own observer resizes the canvas to its device pixels and draws a frame later;
    // this one is created after it, so it runs right after it in the same frame and paints.
    if (addon !== undefined && canvases.length > 0) {
      const sizes = new Map(canvases.map((c) => [c, `${String(c.width)}x${String(c.height)}`]));
      watcher = new ResizeObserver(() => {
        let changed = false;
        for (const canvas of canvases) {
          const size = `${String(canvas.width)}x${String(canvas.height)}`;
          if (sizes.get(canvas) !== size) changed = true;
          sizes.set(canvas, size);
        }
        if (changed) paintNow(term);
      });
      for (const canvas of canvases) {
        watcher.observe(canvas, { box: "device-pixel-content-box" });
      }
    }
  };
  const stop = () => {
    wanted = false;
    retries = 0;
    cancelAnimationFrame(retryFrame);
    retryFrame = 0;
  };
  return {
    show,
    hide() {
      stop();
      drop();
    },
    dispose(disposeTerminal) {
      stop();
      // xterm disposes its addons after its core, so the WebGL addon never builds a DOM
      // renderer just to dispose it.
      const giveBack = release();
      disposeTerminal();
      giveBack();
    },
  };
}
