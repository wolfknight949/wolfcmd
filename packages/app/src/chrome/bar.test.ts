import { describe, expect, it, vi } from "vitest";

import { type BarItem, barGroups, createBarRegistry } from "./bar";

const item = (id: string, order: number): BarItem => ({ id, order, Component: () => null });

describe("N-06 the right bar's registry", () => {
  it("n06_bar_registry: items in order, removable, one ID once", () => {
    const bar = createBarRegistry();
    const listener = vi.fn();
    bar.subscribe(listener);
    const agents = item("wolfcmd.agents", 10);
    const removeAgents = bar.register(agents);
    bar.register(item("plugin.tool", 20));
    bar.register(item("plugin.first", 0));
    expect(bar.list().map((i) => i.id)).toEqual(["plugin.first", "wolfcmd.agents", "plugin.tool"]);
    expect(listener).toHaveBeenCalledTimes(3);
    // The same array until something changes (a stable snapshot).
    expect(bar.list()).toBe(bar.list());
    expect(() => bar.register(item("wolfcmd.agents", 5))).toThrow(/already registered/);
    removeAgents();
    expect(bar.list().map((i) => i.id)).toEqual(["plugin.first", "plugin.tool"]);
  });
});

describe("N-07 bar placement", () => {
  it("n07_bar_groups: bottom items sit apart, each group in order", () => {
    const bar = createBarRegistry();
    bar.register({ ...item("wolfcmd.settings", 1000), placement: "bottom" });
    bar.register(item("wolfcmd.agents", 100));
    bar.register({ ...item("plugin.foot", 900), placement: "bottom" });
    bar.register({ ...item("wolfcmd.add", 0), placement: "top" });
    const groups = barGroups(bar.list());
    expect(groups.top.map((i) => i.id)).toEqual(["wolfcmd.add", "wolfcmd.agents"]);
    expect(groups.bottom.map((i) => i.id)).toEqual(["plugin.foot", "wolfcmd.settings"]);
  });
});
