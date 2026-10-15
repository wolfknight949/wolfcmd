import type { Layout } from "@wolfcmd/bindings";
import { describe, expect, it } from "vitest";

import {
  dragRatios,
  geometry,
  leaf,
  MIN_RATIO,
  neighbor,
  normalized,
  panelsOf,
  removePanel,
  setRatios,
  splitPanel,
} from "./layout";
import { terminalPanel } from "./panels";

const one = leaf(terminalPanel("a"));

describe("N-03 layout", () => {
  it("splits a panel, then adds a sibling in the same direction", () => {
    const two = splitPanel(one, "a", "right", terminalPanel("b"), "x1");
    expect(two).toMatchObject({ kind: "split", direction: "row", ratios: [0.5, 0.5] });
    const three = splitPanel(two, "b", "right", terminalPanel("c"), "x2");
    expect(three).toMatchObject({ kind: "split", id: "x1", ratios: [0.5, 0.25, 0.25] });
    expect(panelsOf(three).map((p) => p.id)).toEqual(["a", "b", "c"]);
    const nested = splitPanel(three, "c", "down", terminalPanel("d"), "x3");
    expect(nested.kind === "split" && nested.children[2]).toMatchObject({
      kind: "split",
      direction: "column",
    });
  });

  it("closes a panel; a lone split child takes over", () => {
    const split = splitPanel(one, "a", "down", terminalPanel("b"), "x1");
    expect(removePanel(split, "b")).toEqual(one);
    expect(removePanel(one, "a")).toBeUndefined();
    expect(removePanel(one, "missing")).toBe(one);
  });

  it("keeps every share at least MIN_RATIO and summing to 1", () => {
    const shares = normalized([0.999, 0.001]);
    expect(shares[1]).toBeGreaterThanOrEqual(MIN_RATIO * 0.9);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(normalized([Number.NaN, 1])).toEqual([0.5, 0.5]);
    const split = splitPanel(one, "a", "right", terminalPanel("b"), "x1");
    expect(setRatios(split, "x1", [3, 1])).toMatchObject({ ratios: [0.75, 0.25] });
  });

  it("places panels and dividers with the gap between them", () => {
    const split = splitPanel(one, "a", "right", terminalPanel("b"), "x1");
    const placed = geometry(split, { x: 0, y: 0, width: 206, height: 100 }, 6);
    expect(placed.panels.get("a")).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(placed.panels.get("b")).toEqual({ x: 106, y: 0, width: 100, height: 100 });
    const divider = placed.dividers[0];
    if (divider === undefined) throw new Error("no divider");
    expect(divider.rect).toEqual({ x: 100, y: 0, width: 6, height: 100 });
    expect(dragRatios([0.5, 0.5], divider, 53, 6)[0]).toBeCloseTo(0.25);
    expect(dragRatios([0.5, 0.5], divider, -500, 6)[0]).toBeCloseTo(MIN_RATIO);
  });

  it("finds the neighbor in each direction", () => {
    const grid: Layout = splitPanel(
      splitPanel(one, "a", "right", terminalPanel("b"), "x1"),
      "b",
      "down",
      terminalPanel("c"),
      "x2",
    );
    const { panels } = geometry(grid, { x: 0, y: 0, width: 200, height: 200 }, 0);
    expect(neighbor(panels, "a", "right")).toBe("b");
    expect(neighbor(panels, "b", "down")).toBe("c");
    expect(neighbor(panels, "c", "left")).toBe("a");
    expect(neighbor(panels, "a", "left")).toBeUndefined();
  });
});
