import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { agentBackground, agentColor, lookOptions, readMarkColors, readTheme } from "./theme";

const TOKENS: Record<string, string> = {
  "--wc-term-bg": "#000000",
  "--wc-term-fg": "#cccccc",
  "--wc-term-selection": "#264f78",
  "--wc-agent-tint": "0.5",
  "--wc-workspace-2": "#3fb950",
  "--wc-warning": "#cca700",
  "--wc-dur-fast": "100ms",
};

let root: HTMLElement;

beforeEach(() => {
  root = document.createElement("div");
  for (const [name, value] of Object.entries(TOKENS)) root.style.setProperty(name, value);
  document.body.append(root);
});

afterEach(() => {
  root.remove();
});

describe("N-02 the agent panel look", () => {
  it("n02_agent_tint: the background mixes in the agent's color by the tint token", () => {
    expect(agentBackground("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(agentBackground("#102030", "#ffffff", Number.NaN)).toBe("#102030");
    expect(agentColor(2, root)).toBe("#3fb950");
    expect(agentColor(9, root)).toBeUndefined();
    const plain = readTheme(root);
    const agent = readTheme(root, "#ffffff");
    expect(plain.background).toBe("#000000");
    expect(agent.background).toBe("#808080");
    // The cursor accent follows the panel's own background.
    expect(agent.cursorAccent).toBe("#808080");
  });

  it("n02_find_colors: matches are a trace of the warning color, the active one the color", () => {
    const colors = readMarkColors(root);
    expect(colors.activeMatch).toBe("#cca700");
    expect(colors.match).toBe(agentBackground("#000000", "#cca700", 0.35));
  });
});

describe("N-02 terminal options", () => {
  it("n02_look: font, cursor, contrast and smooth scrolling from the settings", () => {
    const on = lookOptions(
      { font_family: "Cascadia Code", font_size: 15, cursor: "block", smooth_scroll: true },
      root,
    );
    expect(on).toMatchObject({
      fontFamily: "Cascadia Code",
      fontSize: 15,
      cursorStyle: "block",
      minimumContrastRatio: 4.5,
      smoothScrollDuration: 100,
    });
    const off = lookOptions({ font_family: "", cursor: "underline", smooth_scroll: false }, root);
    expect(off.smoothScrollDuration).toBe(0);
    expect(off.cursorStyle).toBe("underline");
  });
});
