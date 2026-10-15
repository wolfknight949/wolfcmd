import { describe, expect, it } from "vitest";

import { dropsAttribute, leaveGhost, parseDuration } from "./motion";

describe("N-01 durations", () => {
  it("parses CSS durations; anything unreadable is no motion", () => {
    expect(parseDuration("167ms")).toBe(167);
    expect(parseDuration(" 0.25s ")).toBe(250);
    expect(parseDuration("0ms")).toBe(0);
    expect(parseDuration("")).toBe(0);
    expect(parseDuration("fast")).toBe(0);
  });
});

describe("N-01 exit copies", () => {
  it("a copy keeps its look but no role, name, id or test hook", () => {
    expect(dropsAttribute("role")).toBe(true);
    expect(dropsAttribute("aria-label")).toBe(true);
    expect(dropsAttribute("id")).toBe(true);
    expect(dropsAttribute("data-tab-id")).toBe(true);
    expect(dropsAttribute("data-activity")).toBe(true);
    expect(dropsAttribute("tabindex")).toBe(true);
    expect(dropsAttribute("class")).toBe(false);
    expect(dropsAttribute("style")).toBe(false);
    expect(dropsAttribute("data-state")).toBe(false);
  });

  it("fades out an inert copy without hooks, removed after its exit; none under reduced motion", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const element = document.createElement("div");
    element.innerHTML =
      '<div role="tab" data-tab-id="t1" aria-selected="true" class="pill">Agents</div>';
    document.documentElement.style.setProperty("--wc-dur-fast", "0ms");
    expect(leaveGhost(element, { parent })).toBeUndefined();
    document.documentElement.style.setProperty("--wc-dur-fast", "100ms");
    const ghost = leaveGhost(element, {
      parent,
      className: "wc-leaving-fade",
      style: { left: "12px" },
    });
    expect(ghost?.parentNode).toBe(parent);
    expect(ghost?.classList.contains("wc-leaving")).toBe(true);
    expect(ghost?.classList.contains("wc-leaving-fade")).toBe(true);
    expect(ghost?.hasAttribute("inert")).toBe(true);
    expect(ghost?.style.left).toBe("12px");
    expect(parent.querySelector("[role], [data-tab-id], [aria-selected]")).toBeNull();
    expect(parent.querySelector(".pill")?.textContent).toBe("Agents");
    ghost?.dispatchEvent(new Event("animationend"));
    expect(ghost?.isConnected).toBe(false);
    document.documentElement.style.removeProperty("--wc-dur-fast");
    parent.remove();
  });
});
