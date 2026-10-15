// Small, pure color math for theme data (hex colors): mixing (an agent panel's
// tinted background, inactive selection) and WCAG contrast (the built-in theme test).

/** `#rgb`, `#rrggbb` or `#rrggbbaa` → [r, g, b] (0–255); `undefined` for anything else. */
export function parseHex(color: string): readonly [number, number, number] | undefined {
  const hex = color.trim().replace(/^#/, "");
  if (!/^(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex)) return undefined;
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex.slice(0, 6);
  const channel = (i: number) => parseInt(full.slice(i, i + 2), 16);
  return [channel(0), channel(2), channel(4)];
}

const toHex = (n: number) =>
  Math.round(Math.min(255, Math.max(0, n)))
    .toString(16)
    .padStart(2, "0");

/** `amount` (0–1) of `top` over `base`, as `#rrggbb`; `base` when either isn't a hex color. */
export function mixColors(base: string, top: string, amount: number): string {
  const a = parseHex(base);
  const b = parseHex(top);
  if (!a || !b) return base;
  const t = Math.min(1, Math.max(0, amount));
  return `#${a.map((from, i) => toHex(from + ((b[i] ?? from) - from) * t)).join("")}`;
}

/** WCAG 2 relative luminance of a hex color (0 for anything else). */
export function luminance(color: string): number {
  const rgb = parseHex(color);
  if (!rgb) return 0;
  const linear = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
}

/** WCAG 2 contrast ratio of two hex colors (1–21). */
export function contrastRatio(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
