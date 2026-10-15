// N-01: every text and icon color keeps its contrast against the surfaces it is drawn on, in the
// dark and the light theme (WCAG 2: 4.5:1 for text, 3:1 for large text, icons and focus rings).
// The colors are read from tokens.css itself, so changing a token re-checks every pair.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const css = readFileSync(join(import.meta.dirname, "tokens.css"), "utf8");

/** The declarations of the first `selector {…}` block after `from`. */
function block(after: string, selector = ":root {"): Map<string, string> {
  const start = css.indexOf(selector, css.indexOf(after));
  const end = css.indexOf("}", start);
  const body = css.slice(start + selector.length, end).replace(/\/\*[\s\S]*?\*\//g, "");
  const tokens = new Map<string, string>();
  for (const match of body.matchAll(/(--wc-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    tokens.set(match[1] ?? "", (match[2] ?? "").trim().replace(/\s+/g, " "));
  }
  return tokens;
}

const DARK = block("");
const LIGHT = new Map([...DARK, ...block("", ':root[data-theme="light"] {')]);

/** An sRGB color with alpha, channels 0–255, alpha 0–1. */
interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

const TRANSPARENT: Rgba = { r: 0, g: 0, b: 0, a: 0 };

/** Splits `a, b, c` at the top level (not inside parentheses). */
function args(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else current += char;
  }
  parts.push(current.trim());
  return parts;
}

/** A token's value as a color (vars, hex, `rgb()` and `color-mix(in srgb, …)` resolved). */
function color(value: string, theme: ReadonlyMap<string, string>): Rgba {
  const v = value.trim();
  const variable = /^var\((--wc-[a-z0-9-]+)\)$/.exec(v);
  if (variable) {
    const target = theme.get(variable[1] ?? "");
    if (target === undefined) throw new Error(`unknown token ${v}`);
    return color(target, theme);
  }
  if (v === "transparent") return TRANSPARENT;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const digits = hex[1] ?? "";
    const full = digits.length === 3 ? digits.replace(/./g, "$&$&") : digits;
    const n = Number.parseInt(full, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const rgb = /^rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+))?\)$/.exec(v);
  if (rgb) {
    return {
      r: Number(rgb[1]),
      g: Number(rgb[2]),
      b: Number(rgb[3]),
      a: rgb[4] === undefined ? 1 : Number(rgb[4]),
    };
  }
  const mix = /^color-mix\(in srgb, (.*)\)$/.exec(v);
  if (mix) {
    const [first = "", second = ""] = args(mix[1] ?? "");
    const share = /^(.*) (\d+(?:\.\d+)?)%$/.exec(first);
    const a = color(share?.[1] ?? first, theme);
    const p = share ? Number(share[2]) / 100 : 0.5;
    const b = color(second, theme);
    // Premultiplied mixing, as CSS does.
    const alpha = a.a * p + b.a * (1 - p);
    if (alpha === 0) return TRANSPARENT;
    const channel = (x: number, y: number) => (x * a.a * p + y * b.a * (1 - p)) / alpha;
    return { r: channel(a.r, b.r), g: channel(a.g, b.g), b: channel(a.b, b.b), a: alpha };
  }
  throw new Error(`not a color: ${v}`);
}

/** `top` painted over `bottom` (an opaque result when `bottom` is opaque). */
function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a + bottom.a * (1 - top.a);
  const channel = (x: number, y: number) => (x * top.a + y * bottom.a * (1 - top.a)) / a;
  return {
    r: channel(top.r, bottom.r),
    g: channel(top.g, bottom.g),
    b: channel(top.b, bottom.b),
    a,
  };
}

function luminance({ r, g, b }: Rgba): number {
  const linear = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function ratio(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/**
 * The contrast of token `fg` over the surface `layers` (bottom first; each token painted over
 * the ones before it, starting from the window's `bg-subtle`).
 */
function contrast(theme: ReadonlyMap<string, string>, fg: string, layers: readonly string[]) {
  const tokenColor = (name: string) => color(`var(--wc-${name})`, theme);
  let surface = tokenColor("bg-subtle");
  for (const layer of layers) surface = over(tokenColor(layer), surface);
  return ratio(over(tokenColor(fg), surface), surface);
}

/** Where text is drawn: the chrome, cards, flyouts, dialogs and the states on them. */
const SURFACES: readonly (readonly string[])[] = [
  ["bg-subtle"],
  ["bg"],
  ["bg-elevated"],
  ["flyout-bg"],
  ["dialog-bg"],
  ["bg-subtle", "fill-hover"],
  ["bg-subtle", "fill-strong"],
  ["flyout-bg", "fill-hover"],
  ["dialog-bg", "button-bg"],
  ["dialog-bg", "button-hover"],
  ["input-bg"],
];

/** Text: at least 4.5:1 on every surface. */
const TEXT = ["fg", "fg-muted"] as const;
/** The quietest text (meta, hints) is never drawn on a hover or control fill. */
const PLAIN_SURFACES = SURFACES.filter((layers) => layers.length === 1);
/** Status text (a notice, a field's error) sits on the chrome, flyouts and dialogs. */
const STATUS = ["danger", "warning", "success"] as const;
const STATUS_SURFACES = [["bg-subtle"], ["bg"], ["flyout-bg"], ["dialog-bg"]] as const;
/** Icons, focus rings and large text: at least 3:1 on the surfaces (not on a button's fill:
 *  the focus ring sits outside the control). */
const ICONS = ["accent", "focus-ring", "danger", "warning", "success"] as const;
const ICON_SURFACES = SURFACES.filter(
  (layers) => !layers.includes("button-bg") && !layers.includes("button-hover"),
);

describe.each([
  ["dark", DARK],
  ["light", LIGHT],
] as const)("N-01 contrast (%s)", (_name, theme) => {
  it.each(TEXT)("n01_contrast_text: %s on every surface is at least 4.5:1", (fg) => {
    for (const layers of SURFACES) {
      expect(contrast(theme, fg, layers), `${fg} on ${layers.join(" + ")}`).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

  it("n01_contrast_subtle: fg-subtle on the plain surfaces is at least 4.5:1", () => {
    for (const layers of PLAIN_SURFACES) {
      expect(contrast(theme, "fg-subtle", layers), layers.join(" + ")).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(STATUS)("n01_contrast_status: %s text is at least 4.5:1 where it is used", (fg) => {
    for (const layers of STATUS_SURFACES) {
      expect(contrast(theme, fg, layers), `${fg} on ${layers.join(" + ")}`).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

  it.each(ICONS)("n01_contrast_icons: %s on every surface is at least 3:1", (fg) => {
    for (const layers of ICON_SURFACES) {
      expect(contrast(theme, fg, layers), `${fg} on ${layers.join(" + ")}`).toBeGreaterThanOrEqual(
        3,
      );
    }
  });

  it("n01_contrast_fills: labels on accent and danger buttons are at least 4.5:1", () => {
    for (const [fg, fill] of [
      ["accent-fg", "accent"],
      ["accent-fg", "accent-hover"],
      ["danger-fill-fg", "danger-fill"],
      ["danger-fill-fg", "danger-fill-hover"],
      ["caption-close-fg", "caption-close"],
      ["tooltip-fg", "tooltip-bg"],
    ] as const) {
      expect(contrast(theme, fg, [fill]), `${fg} on ${fill}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("n01_contrast_terminal: the terminal's text and the workspace colors read clearly", () => {
    expect(contrast(theme, "term-fg", ["term-bg"])).toBeGreaterThanOrEqual(4.5);
    for (let n = 1; n <= 8; n++) {
      // A workspace's dot and a focused panel's border: non-text, 3:1.
      expect(contrast(theme, `workspace-${String(n)}`, ["bg-subtle"])).toBeGreaterThanOrEqual(3);
    }
  });

  it("n01_calm: no pure black or white surface, no pure white text", () => {
    for (const name of ["bg", "bg-subtle", "bg-elevated", "flyout-bg", "term-bg", "fg"]) {
      const { r, g, b } = color(`var(--wc-${name})`, theme);
      const value = [r, g, b].map(Math.round).join(",");
      expect(value, name).not.toBe("0,0,0");
      expect(value, name).not.toBe("255,255,255");
    }
  });
});
