import { afterEach, describe, expect, it } from "vitest";

import {
  activity,
  agentIdle,
  agentWorking,
  forgetActivity,
  groupMark,
  panelMark,
  seen,
} from "./activity";

afterEach(() => {
  activity.setState({}, true);
});

describe("N-06 agent activity", () => {
  it("n06_activity: working, then finished only when the user didn't look", () => {
    agentWorking("p1");
    expect(panelMark(activity.getState(), "p1")).toBe("working");
    // Looking at it: straight back to idle, nothing to mark.
    expect(agentIdle("p1", "looking")).toBe(false);
    expect(activity.getState()).toEqual({});

    agentWorking("p1");
    // Its tab is shown, another panel focused: the header marks it, the pill doesn't.
    expect(agentIdle("p1", "tab")).toBe(false);
    expect(activity.getState().p1).toMatchObject({ state: "finished", tabSeen: true });
    expect(groupMark(activity.getState(), ["p1"])).toMatchObject({ working: false, done: false });

    agentWorking("p2");
    // Away (another tab, or the window behind): an unseen finish, the pill's done mark.
    expect(agentIdle("p2", "away")).toBe(true);
    expect(groupMark(activity.getState(), ["p2", "p3"])).toMatchObject({
      working: false,
      done: true,
    });
  });

  it("n06_activity: idle without working changes nothing", () => {
    expect(agentIdle("p1", "away")).toBe(false);
    expect(activity.getState()).toEqual({});
    const before = activity.getState();
    agentWorking("p1");
    const working = activity.getState();
    agentWorking("p1");
    expect(activity.getState()).toBe(working);
    expect(working).not.toBe(before);
  });

  it("n06_activity: showing the tab clears the pill's mark, looking clears the header's", () => {
    agentWorking("a");
    agentWorking("b");
    agentWorking("c");
    agentIdle("a", "away");
    agentIdle("b", "away");
    expect(groupMark(activity.getState(), ["a", "b", "c"])).toMatchObject({
      working: true,
      done: true,
    });
    // The tab is shown with panel "a" focused.
    seen(["a", "b", "c"], "a");
    expect(panelMark(activity.getState(), "a")).toBeUndefined();
    expect(activity.getState().b).toMatchObject({ state: "finished", tabSeen: true });
    expect(panelMark(activity.getState(), "c")).toBe("working");
    expect(groupMark(activity.getState(), ["a", "b", "c"])).toMatchObject({
      working: true,
      done: false,
    });
    // Nothing new to see: the store keeps its state object.
    const now = activity.getState();
    seen(["a", "b", "c"], "c");
    expect(activity.getState()).toBe(now);
    seen(["a", "b", "c"], "b");
    expect(panelMark(activity.getState(), "b")).toBeUndefined();
  });

  it("n06_activity: closed panels are forgotten", () => {
    agentWorking("kept");
    agentWorking("closed");
    forgetActivity((id) => id === "kept");
    expect(Object.keys(activity.getState())).toEqual(["kept"]);
  });
});

describe("N-06 the finisher's color", () => {
  it("n06_finish_color: a tab's mark takes the color of the agent that finished unseen", () => {
    agentWorking("claude");
    agentIdle("claude", "away", "var(--wc-workspace-7)");
    expect(groupMark(activity.getState(), ["claude", "shell"])).toMatchObject({
      done: true,
      color: "var(--wc-workspace-7)",
    });
    // An agent the catalog didn't know: no color (the accent).
    agentWorking("other");
    agentIdle("other", "away");
    expect(groupMark(activity.getState(), ["other"]).color).toBeUndefined();
  });

  it("n06_finish_color: the latest finisher wins, whatever the panel order", () => {
    agentWorking("a");
    agentWorking("b");
    agentIdle("b", "away", "var(--wc-workspace-1)");
    agentIdle("a", "away", "var(--wc-workspace-5)");
    const first = groupMark(activity.getState(), ["a", "b"]);
    expect(first.color).toBe("var(--wc-workspace-5)");
    expect(groupMark(activity.getState(), ["b", "a"]).color).toBe("var(--wc-workspace-5)");
    // b finishes again later: its color now, and a newer finish.
    agentWorking("b");
    agentIdle("b", "away", "var(--wc-workspace-1)");
    const second = groupMark(activity.getState(), ["a", "b"]);
    expect(second.color).toBe("var(--wc-workspace-1)");
    expect(second.finishedAt).toBeGreaterThan(first.finishedAt ?? 0);
    // Seen in its tab, b's finish no longer counts for the pill: back to a's color.
    seen(["b"], undefined);
    expect(groupMark(activity.getState(), ["a", "b"]).color).toBe("var(--wc-workspace-5)");
  });
});
