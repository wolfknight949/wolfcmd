import { describe, expect, it } from "vitest";

import { contrastRatio, luminance, mixColors, parseHex } from "./color";

describe("color math", () => {
  it("parses short, long and alpha hex colors", () => {
    expect(parseHex("#fff")).toEqual([255, 255, 255]);
    expect(parseHex("#102030")).toEqual([16, 32, 48]);
    expect(parseHex("#10203080")).toEqual([16, 32, 48]);
    expect(parseHex("rgb(1 2 3)")).toBeUndefined();
  });

  it("mixes toward the top color", () => {
    expect(mixColors("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mixColors("#102030", "#ffffff", 0)).toBe("#102030");
    expect(mixColors("#102030", "#ffffff", 1)).toBe("#ffffff");
    expect(mixColors("var(--x)", "#ffffff", 0.5)).toBe("var(--x)");
  });

  it("computes WCAG contrast", () => {
    expect(luminance("#ffffff")).toBeCloseTo(1);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21);
    expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1);
  });
});
