// N-02: the WebGL renderer's life: taken when shown, given back when hidden, asked for again a
// few times after a context loss while shown, and never swapped for a DOM renderer on dispose.
import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createGpu } from "./gpu";

const webgl = vi.hoisted(() => ({
  made: [] as { lose: () => void; disposed: boolean }[],
}));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    private lost: (() => void) | undefined;
    disposed = false;
    constructor() {
      webgl.made.push(this);
    }
    onContextLoss(listener: () => void) {
      this.lost = listener;
    }
    lose() {
      this.lost?.();
    }
    dispose() {
      this.disposed = true;
    }
  },
}));
vi.mock("./paint", () => ({ paintNow: () => undefined }));

const term = { loadAddon: vi.fn() } as unknown as Terminal;
let frames: (() => void)[] = [];
const nextFrame = () => {
  const due = frames;
  frames = [];
  for (const run of due) run();
};

beforeEach(() => {
  webgl.made.length = 0;
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (run: () => void) => frames.push(run));
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("N-02 the WebGL renderer", () => {
  it("n02_gpu_context_loss: a lost context is asked for again while shown, 3 times at most", () => {
    const gpu = createGpu(term, document.createElement("div"));
    gpu.show();
    for (let loss = 1; loss <= 4; loss++) {
      webgl.made.at(-1)?.lose();
      expect(webgl.made.at(-1)?.disposed).toBe(true);
      nextFrame();
      expect(webgl.made).toHaveLength(Math.min(loss, 3) + 1);
    }
    // Hidden and shown again: a fresh start, with its own tries.
    gpu.hide();
    gpu.show();
    expect(webgl.made).toHaveLength(5);
    webgl.made.at(-1)?.lose();
    nextFrame();
    expect(webgl.made).toHaveLength(6);
  });

  it("n02_gpu_context_loss_hidden: a loss after hiding asks for nothing", () => {
    const gpu = createGpu(term, document.createElement("div"));
    gpu.show();
    const first = webgl.made[0];
    webgl.made[0]?.lose();
    gpu.hide();
    nextFrame();
    expect(webgl.made).toEqual([first]);
  });

  it("n02_gpu_dispose: the terminal is disposed with the addon still loaded", () => {
    const gpu = createGpu(term, document.createElement("div"));
    gpu.show();
    let loadedAtDispose: boolean | undefined;
    gpu.dispose(() => {
      loadedAtDispose = webgl.made[0]?.disposed === false;
    });
    // xterm disposes the addon with the terminal (after its core: no DOM renderer is built).
    expect(loadedAtDispose).toBe(true);
    expect(webgl.made[0]?.disposed).toBe(false);
  });
});
