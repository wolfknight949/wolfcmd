import { describe, expect, it } from "vitest";

import { tooltipDelay, tooltipPlacement, tooltipText } from "./tooltip";

const base = {
  anchor: { left: 100, top: 200, right: 140, bottom: 224 },
  size: { width: 80, height: 30 },
  viewport: { width: 800, height: 600 },
  margin: 8,
  gap: 8,
  cursor: 20,
};

describe("tooltip placement", () => {
  it("centers above the pointer", () => {
    expect(tooltipPlacement({ ...base, pointer: { x: 120, y: 210 } })).toEqual({
      left: 80,
      top: 172,
      side: "top",
    });
  });

  it("centers above the focused element without a pointer", () => {
    expect(tooltipPlacement(base)).toEqual({ left: 80, top: 162, side: "top" });
  });

  it("goes below when there is no room above (the title bar)", () => {
    const anchor = { left: 100, top: 4, right: 140, bottom: 36 };
    expect(tooltipPlacement({ ...base, anchor })).toEqual({ left: 80, top: 44, side: "bottom" });
    // Under the pointer it clears the cursor.
    const placed = tooltipPlacement({ ...base, anchor, pointer: { x: 120, y: 20 } });
    expect(placed).toEqual({ left: 80, top: 48, side: "bottom" });
  });

  it("stays inside the window", () => {
    const left = tooltipPlacement({ ...base, pointer: { x: 4, y: 300 } });
    expect(left.left).toBe(8);
    const right = tooltipPlacement({ ...base, pointer: { x: 798, y: 300 } });
    expect(right.left).toBe(800 - 80 - 8);
    const wide = tooltipPlacement({ ...base, size: { width: 900, height: 30 } });
    expect(wide.left).toBe(8);
  });
});

describe("tooltip timing and text", () => {
  it("waits the full delay, or the short one right after another tooltip", () => {
    expect(tooltipDelay(1000, undefined, 600, 100)).toBe(600);
    expect(tooltipDelay(1000, 900, 600, 100)).toBe(100);
    expect(tooltipDelay(1000, 300, 600, 100)).toBe(600);
  });

  it("treats a blank title as no tooltip", () => {
    expect(tooltipText(null)).toBeUndefined();
    expect(tooltipText("  ")).toBeUndefined();
    expect(tooltipText(" Split right ")).toBe("Split right");
  });
});
