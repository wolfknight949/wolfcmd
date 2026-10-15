// N-06: the finish reward's rules: when an agent's panel glows, and when it stays quiet.
import { beforeEach, describe, expect, it } from "vitest";

import type { Sight } from "../store/activity";
import { createFinishGlow, glowPlayed, pendingGlows } from "./finish-glow";

let allowed = true;
const glow = () => createFinishGlow({ allowed: () => allowed });
const sights = (all: Record<string, Sight>) => (id: string) => all[id] ?? "away";

beforeEach(() => {
  allowed = true;
  pendingGlows.setState({}, true);
});

describe("N-06 panel finish glow rules", () => {
  it("n06_panel_glow: on screen but not focused, it plays at once in the agent's color", () => {
    glow().finished("p2", "var(--wc-workspace-7)", "tab");
    expect(pendingGlows.getState()).toEqual({
      p2: { color: "var(--wc-workspace-7)", ready: true },
    });
  });

  it("n06_panel_glow: out of sight it waits, and plays once the panel is on screen", () => {
    const g = glow();
    g.finished("p3", "var(--wc-workspace-2)", "away");
    expect(pendingGlows.getState().p3?.ready).toBe(false);
    // Still hidden (another tab shown, the window behind, parked behind a maximized panel).
    g.look(sights({}));
    expect(pendingGlows.getState().p3?.ready).toBe(false);
    // Its tab shown, the maximize ended or the window back: on screen, focused or not.
    g.look(sights({ p3: "looking" }));
    expect(pendingGlows.getState().p3).toEqual({ color: "var(--wc-workspace-2)", ready: true });
  });

  it("n06_panel_glow: never for the panel the user looks at, which also drops a waiting one", () => {
    const g = glow();
    g.finished("p1", "a", "looking");
    expect(pendingGlows.getState()).toEqual({});
    g.finished("p1", "a", "away");
    g.finished("p1", "a", "looking");
    expect(pendingGlows.getState()).toEqual({});
  });

  it("n06_panel_glow: a finish glows once: played, nothing comes back", () => {
    const g = glow();
    g.finished("p2", "a", "away");
    g.look(sights({ p2: "tab" }));
    glowPlayed("p2");
    g.look(sights({ p2: "tab" }));
    expect(pendingGlows.getState()).toEqual({});
  });

  it("n06_panel_glow: each panel glows on its own, in its own color", () => {
    const g = glow();
    g.finished("p2", "var(--wc-workspace-1)", "tab");
    g.finished("p3", "var(--wc-workspace-5)", "away");
    g.finished("p4", "var(--wc-workspace-3)", "away");
    g.look(sights({ p3: "tab" }));
    expect(pendingGlows.getState()).toEqual({
      p2: { color: "var(--wc-workspace-1)", ready: true },
      p3: { color: "var(--wc-workspace-5)", ready: true },
      p4: { color: "var(--wc-workspace-3)", ready: false },
    });
    glowPlayed("p2");
    expect(Object.keys(pendingGlows.getState())).toEqual(["p3", "p4"]);
  });

  it("n06_panel_glow: the setting off or reduced motion keeps it quiet, also for a waiting one", () => {
    allowed = false;
    const g = glow();
    g.finished("p2", "a", "tab");
    expect(pendingGlows.getState()).toEqual({});
    allowed = true;
    g.finished("p3", "a", "away");
    allowed = false;
    g.look(sights({ p3: "tab" }));
    expect(pendingGlows.getState()).toEqual({});
  });

  it("n06_panel_glow: a panel that left the document loses its glow", () => {
    const g = glow();
    g.finished("p2", "a", "away");
    g.finished("p3", "b", "away");
    g.forget((id) => id === "p3");
    expect(Object.keys(pendingGlows.getState())).toEqual(["p3"]);
  });
});
