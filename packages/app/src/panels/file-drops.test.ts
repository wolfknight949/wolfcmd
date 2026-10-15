// N-02: files dropped on a terminal go to the panel under the pointer, and only to a terminal.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as Drops from "../core/drops";
import { type FileDrag, toFileDrag } from "../core/drops";
import { dropLabel, installFileDrops, setDropHandler } from "./file-drops";

const drags = vi.hoisted(() => ({ listener: undefined as ((drag: FileDrag) => void) | undefined }));
vi.mock("../core/drops", async (original) => ({
  ...(await original<typeof Drops>()),
  watchFileDrags: (listener: (drag: FileDrag) => void) => {
    drags.listener = listener;
    return () => {
      drags.listener = undefined;
    };
  },
}));

let panel: HTMLElement;
let gap: HTMLElement;
let stop: () => void;

beforeEach(() => {
  panel = document.createElement("div");
  panel.setAttribute("data-wc-drop", "p1");
  const inner = document.createElement("span");
  panel.append(inner);
  gap = document.createElement("div");
  document.body.append(panel, gap);
  // jsdom has no layout: x < 100 is the terminal (its inner element), the rest a gap.
  document.elementFromPoint = (x: number) => (x < 100 ? inner : gap);
  stop = installFileDrops(document);
});

afterEach(() => {
  stop();
  setDropHandler("p1", undefined);
  panel.remove();
  gap.remove();
});

const send = (drag: FileDrag) => {
  drags.listener?.(drag);
};

describe("N-02 file drops", () => {
  it("n02_drop: the terminal under the pointer gets the paths and is marked while over", () => {
    const handler = vi.fn();
    setDropHandler("p1", handler);
    send({ type: "enter", paths: ["C:\\a b.txt"], x: 10, y: 10 });
    expect(panel.getAttribute("data-wc-drop-over")).toBe("Insert path");
    send({ type: "over", x: 200, y: 10 });
    expect(panel.hasAttribute("data-wc-drop-over")).toBe(false);
    send({ type: "drop", paths: ["C:\\a b.txt", "C:\\c.txt"], x: 20, y: 10 });
    expect(handler).toHaveBeenCalledWith(["C:\\a b.txt", "C:\\c.txt"]);
    expect(panel.hasAttribute("data-wc-drop-over")).toBe(false);
  });

  it("n02_drop: nothing takes a drop between panels, or a panel that takes no files", () => {
    const handler = vi.fn();
    setDropHandler("p1", handler);
    send({ type: "drop", paths: ["C:\\x"], x: 300, y: 0 });
    setDropHandler("p1", undefined);
    send({ type: "enter", paths: ["C:\\x"], x: 10, y: 0 });
    expect(panel.hasAttribute("data-wc-drop-over")).toBe(false);
    send({ type: "drop", paths: ["C:\\x"], x: 10, y: 0 });
    expect(handler).not.toHaveBeenCalled();
  });

  it("n02_drop: a drag that leaves unmarks the panel", () => {
    setDropHandler("p1", vi.fn());
    send({ type: "enter", paths: ["/home/me/a", "/home/me/b"], x: 10, y: 0 });
    expect(panel.getAttribute("data-wc-drop-over")).toBe("Insert 2 paths");
    send({ type: "leave" });
    expect(panel.hasAttribute("data-wc-drop-over")).toBe(false);
  });

  it("n02_drop: labels", () => {
    expect(dropLabel(1)).toBe("Insert path");
    expect(dropLabel(3)).toBe("Insert 3 paths");
  });

  it("n02_drop: Tauri's physical pixels become CSS pixels; empty paths go", () => {
    expect(toFileDrag({ type: "over", position: { x: 300, y: 150 } }, 1.5)).toEqual({
      type: "over",
      x: 200,
      y: 100,
    });
    expect(toFileDrag({ type: "drop", paths: ["", "C:\\a"], position: { x: 4, y: 2 } }, 0)).toEqual(
      {
        type: "drop",
        paths: ["C:\\a"],
        x: 4,
        y: 2,
      },
    );
    expect(toFileDrag({ type: "leave" }, 2)).toEqual({ type: "leave" });
  });
});
