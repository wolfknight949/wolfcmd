import { describe, expect, it } from "vitest";

import {
  clampTabOffset,
  dropTargetAt,
  pastThreshold,
  sameTarget,
  tabIndexAt,
  tabShifts,
  zoneAt,
  zoneRect,
} from "./drop";

const R = { x: 100, y: 100, width: 400, height: 200 };

describe("N-03 panel drop zones", () => {
  it("n03_drop_zone: the nearest edge within a quarter, else the centre", () => {
    expect(zoneAt(R, 110, 200)).toBe("left");
    expect(zoneAt(R, 490, 200)).toBe("right");
    expect(zoneAt(R, 300, 105)).toBe("up");
    expect(zoneAt(R, 300, 295)).toBe("down");
    expect(zoneAt(R, 300, 200)).toBe("center");
    // A corner goes to the closer edge, relative to the panel's size.
    expect(zoneAt(R, 105, 140)).toBe("left");
  });

  it("n03_drop_preview: the half on that side, or the whole panel", () => {
    expect(zoneRect(R, "left")).toEqual({ x: 100, y: 100, width: 200, height: 200 });
    expect(zoneRect(R, "right")).toEqual({ x: 300, y: 100, width: 200, height: 200 });
    expect(zoneRect(R, "up")).toEqual({ x: 100, y: 100, width: 400, height: 100 });
    expect(zoneRect(R, "down")).toEqual({ x: 100, y: 200, width: 400, height: 100 });
    expect(zoneRect(R, "center")).toEqual(R);
  });

  it("n03_drop_target: the panel under the pointer; the dragged one is no target", () => {
    const panels = new Map([
      ["a", { x: 0, y: 0, width: 500, height: 500 }],
      ["b", { x: 500, y: 0, width: 500, height: 500 }],
    ]);
    expect(dropTargetAt(750, 250, "a", panels)).toEqual({ panelId: "b", zone: "center" });
    expect(dropTargetAt(990, 250, "a", panels)).toEqual({ panelId: "b", zone: "right" });
    expect(dropTargetAt(250, 250, "a", panels)).toBeUndefined();
    expect(dropTargetAt(2000, 2000, "a", panels)).toBeUndefined();
    expect(sameTarget({ panelId: "b", zone: "up" }, { panelId: "b", zone: "up" })).toBe(true);
    expect(sameTarget({ panelId: "b", zone: "up" }, undefined)).toBe(false);
    expect(sameTarget(undefined, undefined)).toBe(true);
  });

  it("n03_drag_threshold: a press becomes a drag only after a few pixels", () => {
    expect(pastThreshold(2, 2)).toBe(false);
    expect(pastThreshold(0, 4)).toBe(true);
  });
});

describe("N-03 tab pill reorder", () => {
  it("n03_pill_index: after every other pill whose centre is left of the dragged one", () => {
    expect(tabIndexAt(10, [60, 180, 300])).toBe(0);
    expect(tabIndexAt(200, [60, 180, 300])).toBe(2);
    expect(tabIndexAt(999, [60, 180, 300])).toBe(3);
  });

  it("n03_pill_shifts: the pills between the slots make room by the dragged width", () => {
    expect(tabShifts(4, 0, 2, 100)).toEqual([0, -100, -100, 0]);
    expect(tabShifts(4, 3, 1, 100)).toEqual([0, 100, 100, 0]);
    expect(tabShifts(3, 1, 1, 100)).toEqual([0, 0, 0]);
  });

  it("n03_pill_clamp: a dragged pill stays inside its strip", () => {
    const strip = { left: 0, width: 300 };
    const tab = { left: 100, width: 100 };
    expect(clampTabOffset(-500, tab, strip)).toBe(-100);
    expect(clampTabOffset(500, tab, strip)).toBe(100);
    expect(clampTabOffset(30, tab, strip)).toBe(30);
  });
});
