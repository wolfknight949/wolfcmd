// N-06: the agent marks of a tab pill and a panel header, and the pill's one glow.
import type { Tab } from "@wolfcmd/bindings";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentIcon, AgentStatus } from "../panels/AgentActivity";
import { activity, agentIdle, agentWorking, seen } from "../store/activity";
import { PillActivity } from "./PillActivity";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let root: Root | undefined;
let host: HTMLDivElement;
let reduced = false;

const tab: Tab = {
  id: "t1",
  name: null,
  focused: "p1",
  layout: {
    kind: "split",
    id: "s1",
    direction: "row",
    ratios: [0.5, 0.5],
    children: [
      { kind: "panel", id: "p1", title: null, content: { kind: "terminal" } },
      { kind: "panel", id: "p2", title: null, content: { kind: "terminal" } },
    ],
  },
} as unknown as Tab;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  reduced = false;
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query.includes("reduce") && reduced,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  host.remove();
  activity.setState({}, true);
  vi.unstubAllGlobals();
});

function render(node: React.ReactNode) {
  act(() => {
    root = createRoot(host);
    root.render(node);
  });
}

const marks = () =>
  [...host.querySelectorAll("[data-activity]")].map((e) => e.getAttribute("data-activity"));
const glowing = () => host.querySelector("[data-pill-glow]")?.hasAttribute("data-glowing");

describe("N-06 agent marks", () => {
  it("n06_pill: working, then one glow and a done mark until the tab is seen", () => {
    render(<PillActivity tab={tab} />);
    expect(marks()).toEqual([]);
    act(() => {
      agentWorking("p2");
    });
    expect(marks()).toEqual(["working"]);
    expect(glowing()).toBe(false);
    act(() => {
      agentIdle("p2", "away");
    });
    expect(marks()).toEqual(["done"]);
    expect(glowing()).toBe(true);
    // It plays once: the animation's end takes the attribute off, and it stays off.
    act(() => {
      host
        .querySelector("[data-pill-glow]")
        ?.dispatchEvent(new Event("animationend", { bubbles: true }));
    });
    expect(glowing()).toBe(false);
    act(() => {
      seen(["p1", "p2"], "p1");
    });
    expect(marks()).toEqual([]);
    expect(glowing()).toBe(false);
  });

  it("n06_pill: one mark at a time, in the pill's leading padding: working beats done", () => {
    render(<PillActivity tab={tab} />);
    act(() => {
      agentWorking("p1");
      agentWorking("p2");
    });
    act(() => {
      agentIdle("p2", "away");
    });
    // p2 finished unseen (the pill glowed), p1 still works: only the spinner shows.
    expect(marks()).toEqual(["working"]);
    expect(glowing()).toBe(true);
    const spinner = host.querySelector("[data-activity=working]");
    expect(spinner?.getAttribute("class")).toContain("absolute");
    act(() => {
      agentIdle("p1", "away");
    });
    expect(marks()).toEqual(["done"]);
    expect(host.querySelector("[data-activity=done]")?.className).toContain("absolute");
  });

  it("n06_pill: under reduced motion there is no glow, just the mark", () => {
    reduced = true;
    render(<PillActivity tab={tab} />);
    act(() => {
      agentWorking("p1");
    });
    act(() => {
      agentIdle("p1", "away");
    });
    expect(marks()).toEqual(["done"]);
    expect(glowing()).toBe(false);
  });

  it("n06_pill: a finish seen in the shown tab never glows", () => {
    render(<PillActivity tab={tab} />);
    act(() => {
      agentWorking("p2");
    });
    act(() => {
      agentIdle("p2", "tab");
    });
    expect(marks()).toEqual([]);
    expect(glowing()).toBe(false);
  });

  it("n06_pill_color: the glow and the done mark take the finished agent's color, the latest one's", () => {
    render(<PillActivity tab={tab} />);
    const glow = () => host.querySelector<HTMLElement>("[data-pill-glow]");
    const ended = () => {
      act(() => {
        glow()?.dispatchEvent(new Event("animationend", { bubbles: true }));
      });
    };
    act(() => {
      agentWorking("p1");
      agentWorking("p2");
    });
    act(() => {
      agentIdle("p1", "away", "var(--wc-workspace-7)");
    });
    expect(glowing()).toBe(true);
    expect(glow()?.hasAttribute("data-agent")).toBe(true);
    expect(glow()?.style.getPropertyValue("--wc-glow-agent")).toBe("var(--wc-workspace-7)");
    ended();
    expect(glowing()).toBe(false);
    // A second agent finishes unseen: the pill glows again, in its color, and the mark follows.
    act(() => {
      agentIdle("p2", "away", "var(--wc-workspace-2)");
    });
    expect(glowing()).toBe(true);
    expect(glow()?.style.getPropertyValue("--wc-glow-agent")).toBe("var(--wc-workspace-2)");
    const done = host.querySelector<HTMLElement>("[data-activity=done]");
    expect(done?.style.color).toBe("var(--wc-workspace-2)");
    expect(done?.className).not.toContain("text-success");
    ended();
    // An agent the catalog didn't know: the accent glow and the success check.
    act(() => {
      seen(["p1", "p2"], "p1");
      agentWorking("p1");
    });
    act(() => {
      agentIdle("p1", "away");
    });
    expect(glowing()).toBe(true);
    expect(glow()?.hasAttribute("data-agent")).toBe(false);
    expect(glow()?.style.getPropertyValue("--wc-glow-agent")).toBe("");
    expect(host.querySelector("[data-activity=done]")?.className).toContain("text-success");
  });

  it("n06_header: the icon turns into a spinner in the agent's color while it works, a check once finished", () => {
    render(
      <>
        <AgentIcon panelId="p1" icon="agent" color="var(--wc-workspace-7)" />
        <AgentStatus panelId="p1" />
      </>,
    );
    expect(marks()).toEqual([]);
    expect(host.textContent).not.toContain("Working");
    act(() => {
      agentWorking("p1");
    });
    const spinner = host.querySelector<SVGElement>("[data-activity=working]");
    expect(spinner?.tagName.toLowerCase()).toBe("svg");
    expect(spinner?.style.color).toBe("var(--wc-workspace-7)");
    expect(spinner?.getAttribute("aria-label")).toBe("The agent is working");
    expect(host.textContent).toContain("Working…");
    act(() => {
      agentIdle("p1", "tab");
    });
    expect(marks()).toEqual(["finished"]);
    expect(host.textContent).toContain("Done");
    act(() => {
      seen(["p1"], "p1");
    });
    expect(marks()).toEqual([]);
    expect(host.textContent).not.toContain("Done");
  });
});
