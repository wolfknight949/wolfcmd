// N-03: what a change re-renders. Terminals are counted with a stand-in for TerminalPanel (the
// real one mounts xterm.js); the memoization under test is TabView's own.
import type { Document, PanelContent } from "@wolfcmd/bindings";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Actions } from "../actions";
import {
  activateTab,
  changePanel,
  closePanel,
  dropPanel,
  focusPanel,
  toggleMaximize,
  updateTab,
} from "../model/document";
import { leaf, panelsOf, setRatios } from "../model/layout";
import { terminalPanel, withCwd } from "../model/panels";
import { createFinishGlow } from "../chrome/finish-glow";
import { complete } from "../store/settings";
import { createWorkspaceStore } from "../store/workspaces";
import { TabView } from "./TabView";
import type { PanelViewProps } from "./types";

const renders = vi.hoisted(() => [] as string[]);
/** Terminals mounted (a remount would start or reattach a shell). */
const mounts = vi.hoisted(() => [] as string[]);
vi.mock("./TerminalPanel", async () => {
  const { useEffect } = await import("react");
  return {
    TerminalPanel: ({ panel }: PanelViewProps) => {
      renders.push(panel.id);
      useEffect(() => {
        mounts.push(panel.id);
      }, [panel.id]);
      return null;
    },
  };
});

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const AREA = { width: 1200, height: 600 };

/** N-03: a plugin's panel this WolfCmd doesn't have, with fields of its own. */
const BOARD = { kind: "acme.board", columns: ["todo", "done"] } as PanelContent;

const doc: Document = {
  version: 2,
  active: "w1",
  workspaces: [
    {
      id: "w1",
      name: "",
      folder: "C:\\dev\\app",
      activeTab: "t1",
      tabs: [
        {
          id: "t1",
          name: "",
          focused: "p1",
          layout: {
            kind: "split",
            id: "s1",
            direction: "row",
            ratios: [1 / 3, 1 / 3, 1 / 3],
            children: ["p1", "p2", "p3"].map((id) =>
              leaf(terminalPanel(id, { cwd: "C:\\dev\\app" })),
            ),
          },
        },
        // A hidden tab: its cards are mounted too, and must not re-render either.
        {
          id: "t2",
          name: "",
          focused: "p4",
          layout: leaf(terminalPanel("p4")),
        },
        // N-03: a tab with a panel of a kind nobody registered.
        {
          id: "t3",
          name: "",
          focused: "u1",
          layout: { kind: "panel", id: "u1", content: BOARD },
        },
      ],
    },
  ],
};

let root: Root | undefined;
let host: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  renders.length = 0;
  mounts.length = 0;
  host = document.createElement("div");
  document.body.append(host);
  // jsdom has no layout: the panel area has a size, and observing it reports that size.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(AREA.width);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(AREA.height);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly callback: () => void) {}
      observe() {
        this.callback();
      }
      disconnect() {
        return undefined;
      }
    },
  );
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
  Element.prototype.hasPointerCapture = () => false;
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup() {
  const save = vi.fn();
  const store = createWorkspaceStore({ document: doc, readOnly: false }, save);
  const actions = {
    focusPanel: (panelId: string) => {
      store.apply((d) => focusPanel(d, panelId));
    },
    dropPanel: (panelId: string, targetId: string, zone: "left" | "right" | "center") => {
      store.apply((d) => dropPanel(d, panelId, targetId, zone, () => "s-new"));
    },
    closePanel: (panelId: string) => {
      store.apply((d) => closePanel(d, panelId));
    },
  } as unknown as Actions;
  const settings = complete({});
  const view = (): ReactNode => (
    <TabView
      document={store.getState().document}
      store={store}
      actions={actions}
      settings={settings}
      onGeometry={() => undefined}
    />
  );
  root = createRoot(host);
  const render = () => {
    act(() => {
      root?.render(view());
    });
  };
  store.subscribe(render);
  render();
  return { store, save };
}

/** The terminals rendered since the last call, sorted. */
const rendered = () => renders.splice(0).sort();

describe("N-03 a change re-renders only the panels it touches", () => {
  it("counts TerminalPanel renders across focus, ratio, folder and no-op changes", () => {
    const { store } = setup();
    expect(rendered()).toEqual(["p1", "p2", "p3", "p4"]);

    // The focus moves: the two panels whose focus changed.
    act(() => {
      store.apply((d) => focusPanel(d, "p2"));
    });
    expect(rendered()).toEqual(["p1", "p2"]);

    // The shares change: every box moves, no terminal re-renders.
    act(() => {
      store.apply((d) =>
        updateTab(d, "t1", (t) =>
          t.layout == null ? t : { ...t, layout: setRatios(t.layout, "s1", [0.5, 0.25, 0.25]) },
        ),
      );
    });
    expect(rendered()).toEqual([]);

    // A shell reports a new folder: that panel only. The same folder again: nothing at all.
    act(() => {
      store.apply((d) => changePanel(d, "p3", (p) => withCwd(p, "C:\\dev")));
    });
    expect(rendered()).toEqual(["p3"]);
    const before = store.getState().document;
    act(() => {
      store.apply((d) => changePanel(d, "p3", (p) => withCwd(p, "C:\\dev")));
    });
    expect(store.getState().document).toBe(before);
    expect(rendered()).toEqual([]);
  });

  it("n06_panel_glow: a panel's finish glow plays in its card without re-rendering a terminal", () => {
    setup();
    rendered();
    act(() => {
      createFinishGlow({ allowed: () => true }).finished("p2", "var(--wc-workspace-3)", "tab");
    });
    expect(rendered()).toEqual([]);
    const glow = host.querySelector('[data-panel] [data-panel-glow="p2"]');
    expect(glow?.hasAttribute("data-glowing")).toBe(true);
    expect(host.querySelectorAll("[data-panel-glow][data-glowing]")).toHaveLength(1);
  });

  it("a divider drag moves panels locally and saves once, on release", async () => {
    const { store, save } = setup();
    const divider = host.querySelector<HTMLElement>('[data-divider="s1-0"]');
    if (divider === null) throw new Error("no divider");
    const pointer = (type: string, clientX: number, target: EventTarget = divider) => {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX, clientY: 10 }));
    };
    const frame = () =>
      act(async () => {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });
    rendered();

    act(() => {
      pointer("pointerdown", 400);
    });
    for (const x of [450, 500, 550, 600]) {
      act(() => {
        pointer("pointermove", x);
      });
      await frame();
    }
    // Moved on screen, nothing saved, no terminal re-rendered.
    expect(save).not.toHaveBeenCalled();
    expect(rendered()).toEqual([]);
    // The divider (and the panels beside it) follow the pointer.
    expect(Number.parseFloat(divider.style.left)).toBeGreaterThan(590);

    act(() => {
      pointer("pointerup", 600);
    });
    expect(save).toHaveBeenCalledOnce();
    const saved = store.getState().document.workspaces[0]?.tabs[0]?.layout;
    if (saved?.kind !== "split") throw new Error("no split");
    expect(saved.ratios[0]).toBeGreaterThan(0.45);
    expect(rendered()).toEqual([]);
  });

  it("n03_divider_drag_gone: a drag whose divider goes away (another tab shown) ends unsaved", async () => {
    const { store } = setup();
    const divider = host.querySelector<HTMLElement>('[data-divider="s1-0"]');
    if (divider === null) throw new Error("no divider");
    const start = divider.style.left;
    const pointer = (type: string, clientX: number) => {
      divider.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX, clientY: 10 }));
    };
    act(() => {
      pointer("pointerdown", 400);
      pointer("pointermove", 600);
    });
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(divider.style.left).not.toBe(start);
    // Ctrl+Tab mid-drag: the divider leaves; back on the tab, the saved shares show again.
    act(() => {
      store.apply((d) => activateTab(d, "t2"));
    });
    act(() => {
      store.apply((d) => activateTab(d, "t1"));
    });
    const again = host.querySelector<HTMLElement>('[data-divider="s1-0"]');
    expect(again?.style.left).toBe(start);
    // Its release (on the removed node) saves nothing.
    act(() => {
      pointer("pointerup", 600);
    });
    const saved = store.getState().document.workspaces[0]?.tabs[0]?.layout;
    expect(saved?.kind === "split" && saved.ratios).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  it("n03_panel_drag: a header dragged onto a side moves the panel there, without a remount", async () => {
    const { store, save } = setup();
    const header = host.querySelector<HTMLElement>('[data-panel="p1"] [data-panel-header]');
    const zone = host.querySelector<HTMLElement>("[data-drop-zone]");
    if (header === null || zone === null) throw new Error("no header or drop zone");
    const pointer = (type: string, clientX: number, clientY: number) => {
      header.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX, clientY }));
    };
    const frame = () =>
      act(async () => {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });
    const mounted = [...mounts].sort();
    rendered();

    act(() => {
      pointer("pointerdown", 100, 10);
    });
    // Below the threshold: still a click.
    act(() => {
      pointer("pointermove", 102, 11);
    });
    await frame();
    expect(zone.dataset.shown).toBeUndefined();
    // Over the right edge of p3: its right half is the preview; nothing saved or rendered yet.
    act(() => {
      pointer("pointermove", 1180, 300);
    });
    await frame();
    expect(zone.dataset.shown).toBe("");
    expect(zone.dataset.zone).toBe("right");
    expect(save).not.toHaveBeenCalled();
    expect(rendered()).toEqual([]);

    act(() => {
      pointer("pointerup", 1180, 300);
    });
    expect(save).toHaveBeenCalledOnce();
    const layout = store.getState().document.workspaces[0]?.tabs[0]?.layout;
    expect(layout == null ? [] : panelsOf(layout).map((p) => p.id)).toEqual(["p2", "p3", "p1"]);
    expect(zone.dataset.shown).toBeUndefined();
    // The moved panel kept its terminal: nothing mounted again.
    expect([...mounts].sort()).toEqual(mounted);
  });

  it("n03_panel_drag_cancel: Esc puts everything back and changes nothing", async () => {
    const { save } = setup();
    const header = host.querySelector<HTMLElement>('[data-panel="p1"] [data-panel-header]');
    const zone = host.querySelector<HTMLElement>("[data-drop-zone]");
    if (header === null || zone === null) throw new Error("no header or drop zone");
    const pointer = (type: string, clientX: number) => {
      header.dispatchEvent(
        new MouseEvent(type, { bubbles: true, button: 0, clientX, clientY: 300 }),
      );
    };
    act(() => {
      pointer("pointerdown", 100);
      pointer("pointermove", 700);
    });
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(zone.dataset.shown).toBe("");
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      pointer("pointerup", 700);
    });
    expect(zone.dataset.shown).toBeUndefined();
    expect(save).not.toHaveBeenCalled();
  });
});

describe("N-03 maximize", () => {
  it("n03_maximize_view: the panel fills the area, the others stay mounted and parked", () => {
    const { store } = setup();
    const card = (id: string) => {
      const element = host.querySelector<HTMLElement>(`[data-panel="${id}"]`);
      if (element === null) throw new Error(`no card ${id}`);
      return element;
    };
    const mounted = [...mounts].sort();
    const before = card("p1").style.cssText;
    rendered();

    act(() => {
      store.apply((d) => toggleMaximize(d, "p2"));
    });
    expect(card("p2").style.left).toBe("0px");
    expect(card("p2").style.width).toBe(`${String(AREA.width)}px`);
    expect(card("p2").classList.contains("invisible")).toBe(false);
    for (const id of ["p1", "p3"]) {
      expect(card(id).classList.contains("invisible")).toBe(true);
      expect(card(id).style.left).toBe("-32768px");
    }
    expect(host.querySelector("[data-divider]")).toBeNull();
    // Hidden, not re-rendered for nothing, never remounted.
    expect(rendered()).toEqual(["p1", "p2", "p3"]);
    expect([...mounts].sort()).toEqual(mounted);

    act(() => {
      store.apply((d) => toggleMaximize(d, "p2"));
    });
    expect(card("p1").style.cssText).toBe(before);
    expect(host.querySelector("[data-divider]")).not.toBeNull();
    expect([...mounts].sort()).toEqual(mounted);
  });
});

describe("N-03 panel types", () => {
  it("n03_unknown_kind: a kind nobody registered gets a calm card with Close; its data stays", () => {
    const { store, save } = setup();
    const card = host.querySelector<HTMLElement>('[data-panel="u1"]');
    if (card === null) throw new Error("no card for the unknown panel");
    expect(card.textContent).toContain("This panel needs the plugin “acme”.");
    // Its header names its kind; no terminal was mounted for it.
    expect(card.querySelector("[data-panel-header]")?.textContent).toContain("acme.board");
    expect(mounts).not.toContain("u1");
    // A change elsewhere keeps its content: the very same object, every field.
    act(() => {
      store.apply((d) => focusPanel(d, "p2"));
    });
    const kept = store.getState().document.workspaces[0]?.tabs[2]?.layout;
    expect(kept?.kind === "panel" && kept.content).toBe(BOARD);
    expect(save).toHaveBeenCalled();
    // Close removes it like any panel.
    const close = [...card.querySelectorAll("button")].find((b) => b.textContent.endsWith("Close"));
    act(() => {
      close?.click();
    });
    expect(store.getState().document.workspaces[0]?.tabs[2]?.layout).toBeNull();
  });
});
