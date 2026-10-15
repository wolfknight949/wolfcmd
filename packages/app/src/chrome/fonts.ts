// N-07: which terminal fonts this computer has, for the Settings dialog: a short list of known
// monospace families checked with text measurements (a family that is missing measures like
// the fallback), so nothing asks the system or needs a permission. Checked once, when asked.

/** Width of `text` drawn in the CSS `font`. */
export type Measure = (font: string, text: string) => number;

/** Known monospace families, the common ones first. */
const MONOSPACE_FAMILIES = [
  "Cascadia Mono",
  "Cascadia Code",
  "Consolas",
  "JetBrains Mono",
  "Fira Code",
  "Fira Mono",
  "Source Code Pro",
  "Hack",
  "Iosevka",
  "IBM Plex Mono",
  "Roboto Mono",
  "Ubuntu Mono",
  "DejaVu Sans Mono",
  "Liberation Mono",
  "Noto Sans Mono",
  "Inconsolata",
  "Victor Mono",
  "Geist Mono",
  "Commit Mono",
  "Maple Mono",
  "Monaspace Neon",
  "Intel One Mono",
  "CaskaydiaCove Nerd Font",
  "CaskaydiaMono Nerd Font",
  "JetBrainsMono Nerd Font",
  "FiraCode Nerd Font",
  "MesloLGS NF",
  "SF Mono",
  "Menlo",
  "Monaco",
  "Lucida Console",
  "Courier New",
] as const;

const SAMPLE = "mmmmmmmmmmlli10WQ@";
const FALLBACKS = ["monospace", "serif", "sans-serif"] as const;

/** Pure: a CSS font-family list's first family, without quotes ("" for none). */
export function firstFamily(list: string): string {
  const first = list.split(",")[0] ?? "";
  return first
    .trim()
    .replace(/^(["'])(.*)\1$/, "$2")
    .trim();
}

const quoted = (family: string) => `"${family.replaceAll('"', "")}"`;

/** Whether `family` is installed: it measures unlike every fallback on its own. */
function isInstalled(family: string, measure: Measure): boolean {
  if (family === "") return false;
  return FALLBACKS.some(
    (fallback) =>
      measure(`32px ${quoted(family)}, ${fallback}`, SAMPLE) !==
      measure(`32px ${fallback}`, SAMPLE),
  );
}

/** Whether `family`'s narrow and wide letters have the same width. */
function isMonospaced(family: string, measure: Measure): boolean {
  const font = `32px ${quoted(family)}, monospace`;
  return measure(font, "iiiiiiiiii") === measure(font, "MMMMMMMMMM");
}

/** The known monospace families this computer has, in list order. */
export function installedMonospace(measure: Measure): string[] {
  return MONOSPACE_FAMILIES.filter((family) => isInstalled(family, measure));
}

/** What the dialog says about a typed font family. */
export type FontCheck = "default" | "ok" | "missing" | "proportional";

/** Pure given `measure`: the typed family list judged by its first family. */
export function checkFont(list: string, measure: Measure | undefined): FontCheck {
  const family = firstFamily(list);
  if (family === "") return "default";
  // Generic families (`monospace`, `ui-monospace`) are always there.
  if (measure === undefined || /^(ui-)?monospace$/i.test(family)) return "ok";
  if (!isInstalled(family, measure)) return "missing";
  return isMonospaced(family, measure) ? "ok" : "proportional";
}

let canvas: Measure | null | undefined;

/** Measures with a 2D canvas; `undefined` where there is none (tests). */
export function canvasMeasure(): Measure | undefined {
  if (canvas === undefined) {
    const context = document.createElement("canvas").getContext("2d");
    canvas =
      context === null
        ? null
        : (font, text) => {
            context.font = font;
            return context.measureText(text).width;
          };
  }
  return canvas ?? undefined;
}
