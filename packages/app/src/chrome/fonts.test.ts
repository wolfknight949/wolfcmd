// N-07: which fonts are installed, judged from text widths.
import { describe, expect, it } from "vitest";

import { checkFont, firstFamily, installedMonospace, type Measure } from "./fonts";

/** A fake text measure: Consolas and Cascadia Mono are installed and monospaced, Arial is a
 *  proportional font, everything else falls back. */
const measure: Measure = (font, text) => {
  const family = /^32px "([^"]+)"/.exec(font)?.[1];
  const fallback = font.includes("serif") && !font.includes("sans") ? 1.1 : 1;
  if (family === "Consolas" || family === "Cascadia Mono") return text.length * 10;
  if (family === "Arial") return text.length * 12 - (text.split("i").length - 1) * 8;
  return text.length * 9 * fallback;
};

describe("N-07 terminal fonts", () => {
  it("n07_installed_fonts: the known families this computer has", () => {
    expect(installedMonospace(measure)).toEqual(["Cascadia Mono", "Consolas"]);
  });

  it("n07_font_check: default, installed, missing and proportional", () => {
    expect(checkFont("  ", measure)).toBe("default");
    expect(checkFont("Consolas", measure)).toBe("ok");
    expect(checkFont("'Cascadia Mono', monospace", measure)).toBe("ok");
    expect(checkFont("monospace", measure)).toBe("ok");
    expect(checkFont("Nope Mono", measure)).toBe("missing");
    expect(checkFont("Arial", measure)).toBe("proportional");
    // Without a way to measure, nothing is flagged.
    expect(checkFont("Nope Mono", undefined)).toBe("ok");
    expect(firstFamily(' "Fira Code" , monospace')).toBe("Fira Code");
  });
});
