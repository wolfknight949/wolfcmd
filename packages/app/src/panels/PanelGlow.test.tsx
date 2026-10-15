// N-06: a panel's finish glow: played through the DOM from its own panel's entry, once, then quiet.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFinishGlow, pendingGlows } from "../chrome/finish-glow";
import { PanelGlow } from "./PanelGlow";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let root: Root | undefined;
let host: HTMLDivElement;
const rules = createFinishGlow({ allowed: () => true });

const mount = () => {
  act(() => {
    root = createRoot(host);
    root.render(
      <>
        <PanelGlow panelId="p1" />
        <PanelGlow panelId="p2" />
      </>,
    );
  });
};

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  pendingGlows.setState({}, true);
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  host.remove();
});

const overlay = (id: string) => host.querySelector<HTMLElement>(`[data-panel-glow="${id}"]`);

describe("N-06 panel glow", () => {
  it("n06_panel_glow_view: an overlay nobody can point at or read, quiet until played", () => {
    mount();
    const element = overlay("p1");
    expect(element?.getAttribute("aria-hidden")).toBe("true");
    expect(element?.classList.contains("wc-finish-glow")).toBe(true);
    expect(element?.hasAttribute("data-glowing")).toBe(false);
    // N-06: a pulse of the edge line and haze; nothing that travels around the panel.
    expect(element?.querySelector(".wc-finish-glow-line")).not.toBeNull();
    expect(element?.querySelector(".wc-finish-glow-haze")).not.toBeNull();
    expect(element?.children).toHaveLength(2);
  });

  it("n06_panel_glow_view: plays its own panel's glow once, in the agent's color, then is quiet", () => {
    mount();
    rules.finished("p1", "var(--wc-workspace-7)", "away");
    expect(overlay("p1")?.hasAttribute("data-glowing")).toBe(false);
    rules.look(() => "tab");
    const element = overlay("p1");
    expect(element?.hasAttribute("data-glowing")).toBe(true);
    expect(element?.style.getPropertyValue("--wc-finish-glow-agent")).toBe("var(--wc-workspace-7)");
    expect(overlay("p2")?.hasAttribute("data-glowing")).toBe(false);
    // Played: the entry is gone, so it never plays again.
    expect(pendingGlows.getState()).toEqual({});
    // A child's animation ending is not the glow's.
    element
      ?.querySelector(".wc-finish-glow-line")
      ?.dispatchEvent(new Event("animationend", { bubbles: true }));
    expect(element?.hasAttribute("data-glowing")).toBe(true);
    element?.dispatchEvent(new Event("animationend"));
    expect(element?.hasAttribute("data-glowing")).toBe(false);
  });

  it("n06_panel_glow_view: two agents finishing glow their own panels, each in its color", () => {
    mount();
    rules.finished("p1", "var(--wc-workspace-1)", "away");
    rules.finished("p2", "var(--wc-workspace-5)", "away");
    rules.look(() => "tab");
    expect(overlay("p1")?.style.getPropertyValue("--wc-finish-glow-agent")).toBe(
      "var(--wc-workspace-1)",
    );
    expect(overlay("p2")?.style.getPropertyValue("--wc-finish-glow-agent")).toBe(
      "var(--wc-workspace-5)",
    );
    expect(overlay("p1")?.hasAttribute("data-glowing")).toBe(true);
    expect(overlay("p2")?.hasAttribute("data-glowing")).toBe(true);
    expect(pendingGlows.getState()).toEqual({});
  });

  it("n06_panel_glow_view: a glow ready before the card mounts plays when it does", () => {
    rules.finished("p2", undefined, "tab");
    mount();
    expect(overlay("p2")?.hasAttribute("data-glowing")).toBe(true);
    expect(overlay("p2")?.style.getPropertyValue("--wc-finish-glow-agent")).toBe("");
  });

  it("n06_panel_glow_view: once unmounted, nothing plays", () => {
    mount();
    const element = overlay("p1");
    act(() => {
      root?.unmount();
    });
    root = undefined;
    rules.finished("p1", "x", "tab");
    expect(element?.hasAttribute("data-glowing")).toBe(false);
    expect(pendingGlows.getState().p1?.ready).toBe(true);
  });
});
