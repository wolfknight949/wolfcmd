// N-01 / N-02: the terminal's look from the design tokens (`--wc-term-*`, which follow the
// light or dark theme) and the user's settings (font, size, cursor, smooth scrolling). An agent
// panel's background carries a trace of the agent's color.
import type { AppearanceSettings } from "@wolfcmd/bindings";
import { mixColors, parseDuration } from "@wolfcmd/ui-kit";
import type { ITerminalOptions, ITheme } from "@xterm/xterm";

const ANSI = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

/** Text is lifted to WCAG AA against its background (dim TUI text stays readable). */
const MINIMUM_CONTRAST = 4.5;

/** Reads `--wc-<name>` from `root`. */
function token(name: string, root: Element = document.documentElement): string {
  return getComputedStyle(root).getPropertyValue(`--wc-${name}`).trim();
}

/**
 * An agent panel's background: the terminal background with a trace of the agent's color
 * (`--wc-agent-tint`), calmer than a plain shell yet obviously a terminal.
 */
export function agentBackground(background: string, agentColor: string, amount: number): string {
  return mixColors(background, agentColor, Number.isFinite(amount) ? amount : 0);
}

/**
 * An agent's color (`AgentInfo.color`, an index into the workspace palette) as a CSS color
 * read from the tokens; `undefined` when the palette has no such entry.
 */
export function agentColor(
  index: number,
  root: Element = document.documentElement,
): string | undefined {
  const value = token(`workspace-${String(index)}`, root);
  return value === "" ? undefined : value;
}

/** The terminal palette from the `--wc-term-*` tokens; `agent` tints an agent panel's background. */
export function readTheme(root: Element = document.documentElement, agent?: string): ITheme {
  const term = (name: string) => token(`term-${name}`, root);
  const plain = term("bg");
  const background =
    agent === undefined ? plain : agentBackground(plain, agent, Number(token("agent-tint", root)));
  const foreground = term("fg");
  const selection = term("selection");
  const theme: ITheme = {
    foreground,
    background,
    cursor: term("cursor"),
    cursorAccent: background,
    selectionBackground: selection,
    selectionInactiveBackground: mixColors(selection, plain, 0.5),
    // N-01: xterm's own scrollbar in the chrome's quiet scrollbar tones (thin, muted).
    scrollbarSliderBackground: `${mixColors(background, foreground, 0.2)}99`,
    scrollbarSliderHoverBackground: `${mixColors(background, foreground, 0.35)}cc`,
    scrollbarSliderActiveBackground: mixColors(background, foreground, 0.45),
    // The command-mark ruler shares the scrollbar's track; xterm's default border drew a
    // full-height line beside it.
    overviewRulerBorder: background,
  };
  ANSI.forEach((name, i) => {
    theme[name] = term(String(i));
  });
  return theme;
}

/** The colors of find matches and command marks, from the tokens (canvas parts need values). */
export interface MarkColors {
  readonly match: string;
  readonly activeMatch: string;
  readonly neutral: string;
  readonly failure: string;
}

export function readMarkColors(root: Element = document.documentElement): MarkColors {
  const background = token("term-bg", root);
  const warning = token("warning", root);
  return {
    match: mixColors(background, warning, 0.35),
    activeMatch: warning,
    neutral: token("fg-muted", root),
    failure: token("danger", root),
  };
}

/** The xterm options for the user's appearance (everything but the colors). */
export function lookOptions(
  look: Pick<AppearanceSettings, "font_family" | "font_size" | "cursor" | "smooth_scroll">,
  root: Element = document.documentElement,
): ITerminalOptions {
  const family = look.font_family?.trim() ?? "";
  return {
    fontFamily: family === "" ? token("font-mono", root) || "monospace" : family,
    fontSize: look.font_size ?? 14,
    lineHeight: 1.2,
    cursorStyle: look.cursor ?? "bar",
    cursorInactiveStyle: "outline",
    cursorBlink: true,
    cursorWidth: 2,
    minimumContrastRatio: MINIMUM_CONTRAST,
    // A short glide (`--wc-dur-fast`, 0 when the system reduces motion).
    smoothScrollDuration: look.smooth_scroll === false ? 0 : parseDuration(token("dur-fast", root)),
    // Box drawing and block glyphs drawn by xterm: seamless TUI borders at any line height.
    customGlyphs: true,
    rescaleOverlappingGlyphs: true,
  };
}

/** N-01: a terminal color scheme (the `--wc-term-*` tokens of one theme). */
export interface TerminalScheme {
  readonly name: string;
  readonly foreground: string;
  readonly background: string;
  readonly cursor: string;
  readonly selection: string;
  /** The 16 ANSI colors: black, red, green, yellow, blue, magenta, cyan, white, then bright. */
  readonly ansi: readonly string[];
}

/** N-01: VS Code's Dark Modern terminal, the dark theme's (and the default) scheme. */
export const DARK_MODERN: TerminalScheme = {
  name: "Dark Modern",
  foreground: "#cccccc",
  // The block's background (the app's dark surface): the terminal sits in its card seamlessly.
  background: "#1f1f1f",
  cursor: "#aeafad",
  selection: "#264f78",
  ansi: [
    "#000000",
    "#cd3131",
    "#0dbc79",
    "#e5e510",
    "#2472c8",
    "#bc3fbc",
    "#11a8cd",
    "#e5e5e5",
    "#666666",
    "#f14c4c",
    "#23d18b",
    "#f5f543",
    "#3b8eea",
    "#d670d6",
    "#29b8db",
    "#e5e5e5",
  ],
};

/** N-01: its light counterpart, calm on the light chrome (no pure white background). */
export const LIGHT: TerminalScheme = {
  name: "Light",
  foreground: "#2b2f36",
  background: "#fbfbfc",
  cursor: "#3b6fd8",
  selection: "#cfdcf7",
  ansi: [
    "#2b2f36",
    "#c4314b",
    "#2f7d32",
    "#8a6100",
    "#2f5fc4",
    "#8a3fb3",
    "#127a87",
    "#e4e6ea",
    "#6b7280",
    "#d9465d",
    "#3c9441",
    "#a07400",
    "#4274d8",
    "#9d55c4",
    "#1a8d9b",
    "#ffffff",
  ],
};

/** N-01: a scheme as its `--wc-term-*` tokens (what ui-kit's tokens.css declares for it). */
export function schemeTokens(scheme: TerminalScheme): Readonly<Record<string, string>> {
  const tokens: Record<string, string> = {
    "--wc-term-fg": scheme.foreground,
    "--wc-term-bg": scheme.background,
    "--wc-term-cursor": scheme.cursor,
    "--wc-term-selection": scheme.selection,
  };
  scheme.ansi.forEach((color, index) => {
    tokens[`--wc-term-${String(index)}`] = color;
  });
  return tokens;
}
