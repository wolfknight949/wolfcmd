// N-03: a maximized panel fills its tab and toggles back; a split, a drop or closing it ends it.
import type { Document, Tab } from "@wolfcmd/bindings";
import { describe, expect, it } from "vitest";

import {
  activeTab,
  activeWorkspace,
  closePanel,
  dropPanel,
  focusPanel,
  maximizedPanel,
  openPanel,
  toggleMaximize,
} from "./document";
import { leaf, panelsOf } from "./layout";
import { terminalPanel } from "./panels";

const doc = (panels: readonly string[], maximized: string | null = null): Document => ({
  version: 1,
  active: "w1",
  workspaces: [
    {
      id: "w1",
      name: "",
      folder: null,
      activeTab: "t1",
      tabs: [
        {
          id: "t1",
          name: "",
          focused: panels[0] ?? null,
          maximized,
          layout:
            panels.length === 1
              ? leaf(terminalPanel(panels[0] ?? ""))
              : {
                  kind: "split",
                  id: "s1",
                  direction: "row",
                  ratios: panels.map(() => 1 / panels.length),
                  children: panels.map((id) => leaf(terminalPanel(id))),
                },
        },
      ],
    },
  ],
});

const shown = (d: Document): Tab => {
  const tab = activeTab(activeWorkspace(d));
  if (tab === undefined) throw new Error("no tab");
  return tab;
};

describe("N-03 maximize a panel", () => {
  it("n03_maximize: toggles a panel to fill its tab and back, focusing it", () => {
    const start = doc(["p1", "p2"]);
    const maximized = toggleMaximize(start, "p2");
    expect(maximizedPanel(shown(maximized))).toBe("p2");
    expect(shown(maximized).focused).toBe("p2");
    // The layout is untouched: the other panel stays (hidden, mounted).
    expect(shown(maximized).layout).toBe(shown(start).layout);
    const restored = toggleMaximize(maximized, "p2");
    expect(maximizedPanel(shown(restored))).toBeUndefined();
    expect(shown(restored).focused).toBe("p2");
  });

  it("n03_maximize_alone: a tab's only panel can't be maximized", () => {
    const start = doc(["p1"]);
    expect(toggleMaximize(start, "p1")).toBe(start);
    // A saved mark on a lone panel or a gone one means nothing.
    expect(maximizedPanel(shown(doc(["p1"], "p1")))).toBeUndefined();
    expect(maximizedPanel(shown(doc(["p1", "p2"], "gone")))).toBeUndefined();
  });

  it("n03_maximize_close: closing the maximized panel shows the tiles again", () => {
    const start = doc(["p1", "p2", "p3"], "p2");
    expect(maximizedPanel(shown(closePanel(start, "p2")))).toBeUndefined();
    // Closing another one keeps it, until only one panel is left.
    const other = closePanel(start, "p3");
    expect(maximizedPanel(shown(other))).toBe("p2");
    expect(shown(closePanel(other, "p1")).maximized).toBeNull();
  });

  it("n03_maximize_split_drop: a split or a drop ends the maximize", () => {
    const start = doc(["p1", "p2"], "p1");
    const split = openPanel(start, terminalPanel("p3"), "right", () => "s2");
    expect(maximizedPanel(shown(split))).toBeUndefined();
    const layout = shown(split).layout;
    expect(layout == null ? [] : panelsOf(layout).map((p) => p.id)).toEqual(["p1", "p3", "p2"]);
    const dropped = dropPanel(start, "p1", "p2", "right", () => "s2");
    expect(maximizedPanel(shown(dropped))).toBeUndefined();
  });

  it("n03_maximize_focus: focusing a hidden panel shows the tiles; the maximized one keeps them hidden", () => {
    const start = doc(["p1", "p2"], "p1");
    expect(focusPanel(start, "p1")).toBe(start);
    const other = focusPanel(start, "p2");
    expect(maximizedPanel(shown(other))).toBeUndefined();
    expect(shown(other).focused).toBe("p2");
  });
});
