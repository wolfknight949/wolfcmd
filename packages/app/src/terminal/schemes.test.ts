// N-01: the terminal schemes and the tokens the terminal reads stay the same colors.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DARK_MODERN, LIGHT, schemeTokens } from "./theme";

const css = readFileSync(
  join(import.meta.dirname, "../../../ui-kit/src/tokens/tokens.css"),
  "utf8",
);

/** The `--wc-term-*` declarations of the first block with `selector`. */
function termTokens(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  const body = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries(
    [...body.matchAll(/(--wc-term-(?:fg|bg|cursor|selection|\d+))\s*:\s*(#[0-9a-f]{6});/gi)].map(
      (m) => [m[1] ?? "", (m[2] ?? "").toLowerCase()],
    ),
  );
}

describe("N-01 terminal schemes", () => {
  it("n01_schemes: Dark Modern is the dark tokens, Light the light ones", () => {
    expect(termTokens(":root {")).toEqual(schemeTokens(DARK_MODERN));
    expect(termTokens(':root[data-theme="light"] {')).toEqual(schemeTokens(LIGHT));
  });

  it("n01_schemes_shape: 16 ANSI colors, hex only (the terminal mixes them)", () => {
    for (const scheme of [DARK_MODERN, LIGHT]) {
      expect(scheme.ansi).toHaveLength(16);
      for (const value of Object.values(schemeTokens(scheme))) {
        expect(value).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });
});
