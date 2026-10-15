// N-02: what a terminal panel shows around its terminal: the find bar, the paste question, a
// command's menu, the header's attention bell and progress, and a tab's attention dot.
import type { Workspace } from "@wolfcmd/bindings";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Actions } from "../actions";
import { TabPills } from "../chrome/TabPills";
import { leaf } from "../model/layout";
import { terminalPanel } from "../model/panels";
import { attention, progress, requestAttention, setProgress } from "../store/attention";
import type { MarkActions } from "../terminal/marks";
import { FindBar, matchCount } from "./FindBar";
import { MarkMenu, markMenuItems } from "./MarkMenu";
import { PanelHeader, progressLabel } from "./PanelHeader";
import { PasteConfirm, pastePreview } from "./PasteConfirm";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let root: Root | undefined;
let host: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {
        return undefined;
      }
      unobserve() {
        return undefined;
      }
      disconnect() {
        return undefined;
      }
    },
  );
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  host.remove();
  attention.setState({}, true);
  progress.setState({}, true);
  vi.unstubAllGlobals();
});

function show(node: ReactNode) {
  root ??= createRoot(host);
  act(() => {
    root?.render(node);
  });
}

function key(target: Element, init: KeyboardEventInit) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  });
}

function type(input: HTMLInputElement, value: string) {
  act(() => {
    // The prototype's setter: React tracks the element's own one.
    const field = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value") as
      { readonly set?: (this: HTMLInputElement, next: string) => void } | undefined;
    field?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("N-02 find bar", () => {
  it("n02_find: searches as you type, Enter / Shift+Enter move, Esc closes", () => {
    const onFind = vi.fn();
    const onClose = vi.fn();
    show(<FindBar results={{ index: 1, count: 12 }} onFind={onFind} onClose={onClose} />);
    const input = host.querySelector("input");
    if (input === null) throw new Error("no field");
    type(input, "err");
    expect(onFind).toHaveBeenLastCalledWith("err", { caseSensitive: false, regex: false }, false);
    key(input, { key: "Enter", shiftKey: true });
    expect(onFind).toHaveBeenLastCalledWith("err", expect.anything(), true);
    act(() => {
      host.querySelector<HTMLButtonElement>('[aria-label="Use regular expression"]')?.click();
    });
    expect(onFind).toHaveBeenLastCalledWith("err", { caseSensitive: false, regex: true }, false);
    expect(host.textContent).toContain("2 of 12");
    key(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("n02_find: the count", () => {
    expect(matchCount("", -1, 0)).toBe("");
    expect(matchCount("x", -1, 0)).toBe("No results");
    expect(matchCount("x", 0, 3)).toBe("1 of 3");
  });
});

describe("N-02 multi-line paste guard", () => {
  it("n02_paste: shows the first lines; Enter pastes, Esc cancels", () => {
    const onPaste = vi.fn();
    const onCancel = vi.fn();
    show(<PasteConfirm text={"a\r\nb\nc\n"} onPaste={onPaste} onCancel={onCancel} />);
    const dialog = host.querySelector('[role="alertdialog"]');
    if (dialog === null) throw new Error("no question");
    expect(dialog.getAttribute("aria-label")).toBe("Paste 3 lines?");
    key(dialog, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    key(dialog, { key: "Enter" });
    expect(onPaste).toHaveBeenCalledTimes(1);
  });

  it("n02_paste: a long paste's preview ends with …", () => {
    expect(pastePreview("1\n2\n3\n4\n5\n6\n7\n8", 6)).toEqual({
      lines: 8,
      preview: "1\n2\n3\n4\n5\n6\n…",
    });
  });
});

describe("N-02 a command's menu", () => {
  const all: MarkActions = {
    copyCommand: true,
    copyOutput: true,
    selectOutput: true,
    rerun: true,
    find: true,
    notify: undefined,
  };

  it("n02_menu_items: the actions in order, dimmed or left out as offered", () => {
    const run = vi.fn();
    const items = markMenuItems({ ...all, rerun: false, notify: true }, run);
    expect(items.map((item) => item.id)).toEqual([
      "copyCommand",
      "copyOutput",
      "selectOutput",
      "rerun",
      "find",
      "notify",
    ]);
    expect(items.find((item) => item.id === "rerun")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "copyCommand")?.disabled).toBeUndefined();
    items[0]?.onSelect();
    expect(run).toHaveBeenCalledWith("copyCommand");
    expect(markMenuItems(all, run).map((item) => item.id)).not.toContain("notify");
  });

  it("n02_mark_menu: opens named after the command", () => {
    show(
      <MarkMenu
        info={{ id: 7, command: "npm test", exitCode: 1, state: "done" }}
        actions={all}
        left={4}
        top={20}
        onAction={vi.fn()}
        onClose={vi.fn()}
        onFocusBack={vi.fn()}
      />,
    );
    const menu = document.querySelector('[role="menu"]');
    expect(menu?.textContent).toContain("Copy command");
    expect(menu?.textContent).toContain("Find in this output");
    expect(document.querySelector('[aria-label="Actions for npm test"]')).not.toBeNull();
  });
});

describe("N-02 attention and progress", () => {
  const actions = {
    focusPanel: vi.fn(),
    newTerminal: vi.fn(),
    closePanel: vi.fn(),
    activateTab: vi.fn(),
    closeTab: vi.fn(),
    renameTab: vi.fn(),
    newTab: vi.fn(),
  } as unknown as Actions;

  it("n02_header: a bell while the program wants the user, and its progress", () => {
    const panel = leaf(terminalPanel("p1"));
    show(
      <PanelHeader
        panel={panel}
        visible
        focused={false}
        folder={null}
        alone={false}
        maximized={false}
        actions={actions}
        onDragStart={vi.fn()}
        look={{ title: "Terminal", icon: "terminal" }}
      />,
    );
    expect(host.querySelector('[role="img"]')).toBeNull();
    act(() => {
      requestAttention("p1", "Claude needs your permission", false);
      setProgress("p1", { state: "normal", value: 40 });
    });
    expect(host.querySelector('[role="img"]')?.getAttribute("title")).toBe(
      "Claude needs your permission",
    );
    const bar = host.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute("aria-valuenow")).toBe("40");
    act(() => {
      setProgress("p1", undefined);
    });
    expect(host.querySelector('[role="progressbar"]')).toBeNull();
  });

  it("n02_header: progress labels", () => {
    expect(progressLabel({ state: "normal", value: 40 })).toBe("40%");
    expect(progressLabel({ state: "error", value: 70 })).toBe("Failed at 70%");
    expect(progressLabel({ state: "paused", value: 5 })).toBe("Paused at 5%");
    expect(progressLabel({ state: "indeterminate", value: 0 })).toBe("Working…");
  });

  it("n02_tab_mark: a calm dot on the tab whose panel wants the user", () => {
    const workspace: Workspace = {
      id: "w1",
      name: "",
      activeTab: "t1",
      tabs: [
        { id: "t1", name: "one", layout: leaf(terminalPanel("p1")) },
        { id: "t2", name: "two", layout: leaf(terminalPanel("p2")) },
      ],
    };
    show(<TabPills workspace={workspace} actions={actions} />);
    const dots = () =>
      [...host.querySelectorAll('[aria-label="A panel here wants your attention"]')].map(
        (dot) => dot.closest('[role="tab"]')?.querySelector(".truncate")?.textContent,
      );
    expect(dots()).toEqual([]);
    act(() => {
      requestAttention("p2", "Done", false);
    });
    expect(dots()).toEqual(["two"]);
  });

  it("n03_pill_press_released_away: a press released off its pill ends; hovering later lifts nothing", () => {
    const captured: Element[] = [];
    const proto = Element.prototype as Partial<Element>;
    const saved = {
      set: proto.setPointerCapture,
      has: proto.hasPointerCapture,
      release: proto.releasePointerCapture,
    };
    Element.prototype.setPointerCapture = function (this: Element) {
      captured.push(this);
    };
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.releasePointerCapture = () => undefined;
    try {
      const moveTab = vi.fn();
      const workspace: Workspace = {
        id: "w1",
        name: "",
        activeTab: "t1",
        tabs: [
          { id: "t1", name: "one", layout: leaf(terminalPanel("p1")) },
          { id: "t2", name: "two", layout: leaf(terminalPanel("p2")) },
        ],
      };
      show(<TabPills workspace={workspace} actions={{ ...actions, moveTab }} />);
      const tab = host.querySelector('[role="tab"]');
      if (tab === null) throw new Error("no tab");
      const pointer = (type: string, clientX: number) => {
        tab.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX, clientY: 5 }));
      };
      act(() => {
        pointer("pointerdown", 10);
      });
      // The tab holds the pointer from the press on (a release anywhere comes back to it).
      expect(captured).toEqual([tab]);
      // The capture went (released off the pill, the window lost it): the press is over.
      act(() => {
        tab.dispatchEvent(new Event("lostpointercapture"));
      });
      act(() => {
        pointer("pointermove", 200);
        pointer("pointerup", 200);
      });
      expect(tab.parentElement?.hasAttribute("data-lifted")).toBe(false);
      expect(moveTab).not.toHaveBeenCalled();
    } finally {
      Object.assign(Element.prototype, {
        setPointerCapture: saved.set,
        hasPointerCapture: saved.has,
        releasePointerCapture: saved.release,
      });
    }
  });
});
