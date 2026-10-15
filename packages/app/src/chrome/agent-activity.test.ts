// N-06: the core's activity changes, where the user looks, the finished notification and its
// click, wired together.
import type { Document } from "@wolfcmd/bindings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Actions } from "../actions";
import { activateTab, toggleMaximize } from "../model/document";
import { leaf } from "../model/layout";
import { terminalPanel } from "../model/panels";
import { activity, panelMark } from "../store/activity";
import { catalog } from "../store/catalog";
import { createWorkspaceStore } from "../store/workspaces";
import { installAgentActivity, sightOf } from "./agent-activity";
import { createFinishGlow, glowPlayed, pendingGlows } from "./finish-glow";

const core = vi.hoisted(() => ({
  activity: undefined as ((panelId: string, working: boolean) => void) | undefined,
  show: undefined as ((panelId: string) => void) | undefined,
  done: vi.fn(),
}));

vi.mock("../core/activity", () => ({
  onAgentActivity: (listener: (panelId: string, working: boolean) => void) => {
    core.activity = listener;
    return () => {
      if (core.activity === listener) core.activity = undefined;
    };
  },
  onShowPanel: (listener: (panelId: string) => void) => {
    core.show = listener;
    return () => {
      if (core.show === listener) core.show = undefined;
    };
  },
  agentDone: core.done,
}));

const panel = (id: string, agent?: string) =>
  leaf(
    terminalPanel(
      id,
      agent === undefined ? {} : { agent: { agent, session: null, cwd: null, running: true } },
    ),
  );

/** Workspace w1: tab t1 (p1 focused, p2) shown, tab t2 (p3, Claude Code) hidden. */
const doc: Document = {
  version: 2,
  active: "w1",
  workspaces: [
    {
      id: "w1",
      name: "wolfcmd",
      folder: null,
      activeTab: "t1",
      tabs: [
        {
          id: "t1",
          name: "Main",
          focused: "p1",
          layout: {
            kind: "split",
            id: "s1",
            direction: "horizontal",
            ratios: [0.5, 0.5],
            children: [panel("p1"), panel("p2")],
          },
        },
        { id: "t2", name: "Fixes", focused: "p3", layout: panel("p3", "claude-code") },
      ],
    },
  ],
} as unknown as Document;

let front = true;

beforeEach(() => {
  front = true;
  vi.spyOn(document, "hasFocus").mockImplementation(() => front);
  catalog.setState({
    agents: [{ id: "claude-code", name: "Claude Code" } as never],
  });
});

afterEach(() => {
  activity.setState({}, true);
  pendingGlows.setState({}, true);
  catalog.setState({ profiles: [], agents: [], problems: [] });
  vi.restoreAllMocks();
  core.done.mockReset();
});

describe("N-06 agent activity wiring", () => {
  it("n06_sight: looking, the tab shown, or away", () => {
    expect(sightOf(doc, "p1", true)).toBe("looking");
    expect(sightOf(doc, "p2", true)).toBe("tab");
    expect(sightOf(doc, "p3", true)).toBe("away");
    expect(sightOf(doc, "p1", false)).toBe("away");
  });

  it("n06_wiring: an unseen finish behind the window tells the core; showing the tab clears it", () => {
    const store = createWorkspaceStore({ document: doc, readOnly: true }, vi.fn());
    const activateTab = vi.fn();
    const focusPanel = vi.fn();
    const actions = { activateTab, focusPanel } as unknown as Actions;
    installAgentActivity(store, actions);

    core.activity?.("p3", true);
    expect(panelMark(activity.getState(), "p3")).toBe("working");
    // Finished in the hidden tab with the window in front: marked, the core isn't told.
    core.activity?.("p3", false);
    expect(panelMark(activity.getState(), "p3")).toBe("finished");
    expect(core.done).not.toHaveBeenCalled();

    // Again with the window behind: the core flashes and notifies, with names only.
    core.activity?.("p3", true);
    front = false;
    core.activity?.("p3", false);
    expect(core.done).toHaveBeenCalledExactlyOnceWith("p3", "Claude Code", "Fixes");

    // Showing its tab (the window in front) clears both marks: p3 is its focused panel.
    front = true;
    store.apply((d) => ({
      ...d,
      workspaces: d.workspaces.map((w) => ({ ...w, activeTab: "t2" })),
    }));
    expect(activity.getState()).toEqual({});

    // A clicked notification shows the tab and the panel.
    core.show?.("p3");
    expect(activateTab).toHaveBeenCalledWith("t2");
    expect(focusPanel).toHaveBeenCalledWith("p3");
  });

  it("n06_sight_maximized: a panel parked behind a maximized one is away", () => {
    const maximized = {
      ...doc,
      workspaces: doc.workspaces.map((w) => ({
        ...w,
        tabs: w.tabs.map((t) => (t.id === "t1" ? { ...t, maximized: "p1" } : t)),
      })),
    };
    expect(sightOf(maximized, "p1", true)).toBe("looking");
    expect(sightOf(maximized, "p2", true)).toBe("away");
  });

  it("n06_seen_maximized: a finish behind a maximized panel keeps its marks until the tiles show", () => {
    const store = createWorkspaceStore({ document: doc, readOnly: true }, vi.fn());
    installAgentActivity(store, {} as Actions);
    const maximize = (id: string | null) => {
      store.apply((d) => ({
        ...d,
        workspaces: d.workspaces.map((w) => ({
          ...w,
          tabs: w.tabs.map((t) => (t.id === "t1" ? { ...t, maximized: id } : t)),
        })),
      }));
    };
    maximize("p1");
    core.activity?.("p2", true);
    core.activity?.("p2", false);
    // Unseen: the pill keeps its check (its tab is shown, but p2 is out of sight).
    expect(activity.getState().p2).toMatchObject({ state: "finished", tabSeen: false });
    // Another change while it stays hidden: still unseen.
    store.apply((d) => ({ ...d, active: "w1" }));
    maximize("p1");
    expect(activity.getState().p2?.tabSeen).toBe(false);
    // The tiles come back: now its tab was seen.
    maximize(null);
    expect(activity.getState().p2).toMatchObject({ state: "finished", tabSeen: true });
  });

  it("n06_install_once: installing again replaces the wiring (a hot reload)", () => {
    const store = createWorkspaceStore({ document: doc, readOnly: true }, vi.fn());
    const first = installAgentActivity(store, {} as Actions);
    const listener = core.activity;
    installAgentActivity(store, {} as Actions);
    expect(core.activity).not.toBe(listener);
    expect(core.activity).toBeDefined();
    // Removing the replaced one changes nothing.
    first();
    expect(core.activity).toBeDefined();
  });

  it("n06_wiring: a finish the user looks at leaves nothing", () => {
    const store = createWorkspaceStore({ document: doc, readOnly: true }, vi.fn());
    installAgentActivity(store, {} as Actions);
    core.activity?.("p1", true);
    core.activity?.("p1", false);
    expect(activity.getState()).toEqual({});
  });

  it("n06_glow_wiring: an agent's panel glows in its color: at once on screen, else when its tab shows", () => {
    catalog.setState({ agents: [{ id: "claude-code", name: "Claude Code", color: 7 } as never] });
    const store = createWorkspaceStore({ document: doc, readOnly: true }, vi.fn());
    installAgentActivity(store, {} as Actions, window, createFinishGlow({ allowed: () => true }));
    // Looked at: never a glow.
    core.activity?.("p1", true);
    core.activity?.("p1", false);
    expect(pendingGlows.getState()).toEqual({});
    // On screen but not focused: at once.
    core.activity?.("p2", true);
    core.activity?.("p2", false);
    expect(pendingGlows.getState().p2).toEqual({ color: undefined, ready: true });
    // In the hidden tab: it waits for its tab, in the agent's color.
    core.activity?.("p3", true);
    core.activity?.("p3", false);
    expect(pendingGlows.getState().p3).toEqual({ color: "var(--wc-workspace-7)", ready: false });
    store.apply((d) => activateTab(d, "t2"));
    expect(pendingGlows.getState().p3).toEqual({ color: "var(--wc-workspace-7)", ready: true });
  });

  it("n06_pill_color_wiring: the finish keeps its agent's color from the catalog for the tab pill", () => {
    catalog.setState({ agents: [{ id: "claude-code", name: "Claude Code", color: 7 } as never] });
    const store = createWorkspaceStore({ document: doc, readOnly: true }, vi.fn());
    installAgentActivity(store, {} as Actions);
    core.activity?.("p3", true);
    core.activity?.("p3", false);
    expect(activity.getState().p3).toMatchObject({
      state: "finished",
      tabSeen: false,
      color: "var(--wc-workspace-7)",
    });
    // A plain terminal's "agent" the catalog doesn't know: no color.
    core.activity?.("p2", true);
    front = false;
    core.activity?.("p2", false);
    expect(activity.getState().p2?.color).toBeUndefined();
  });

  it("n06_glow_wiring: it waits for the window to come back and for a maximize to end", () => {
    const store = createWorkspaceStore({ document: doc, readOnly: true }, vi.fn());
    installAgentActivity(store, {} as Actions, window, createFinishGlow({ allowed: () => true }));
    // The window behind: even the focused panel waits, and plays when the user is back.
    front = false;
    core.activity?.("p1", true);
    core.activity?.("p1", false);
    expect(pendingGlows.getState().p1?.ready).toBe(false);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(pendingGlows.getState().p1?.ready).toBe(false);
    front = true;
    window.dispatchEvent(new Event("focus"));
    expect(pendingGlows.getState().p1?.ready).toBe(true);
    glowPlayed("p1");
    // Parked behind a maximized panel: it waits for the tiles.
    store.apply((d) => toggleMaximize(d, "p1"));
    core.activity?.("p2", true);
    core.activity?.("p2", false);
    expect(pendingGlows.getState().p2?.ready).toBe(false);
    store.apply((d) => toggleMaximize(d, "p1"));
    expect(pendingGlows.getState().p2?.ready).toBe(true);
    // A closed panel loses its glow.
    core.activity?.("p3", true);
    core.activity?.("p3", false);
    expect(pendingGlows.getState().p3).toBeDefined();
    store.apply((d) => ({
      ...d,
      workspaces: d.workspaces.map((w) => ({ ...w, tabs: w.tabs.filter((t) => t.id !== "t2") })),
    }));
    expect(pendingGlows.getState().p3).toBeUndefined();
  });
});
