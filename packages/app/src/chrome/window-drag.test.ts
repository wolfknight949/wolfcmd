import { afterEach, describe, expect, it, vi } from "vitest";

import { DRAG_CLASS, installWindowDrag, isDragTarget, NO_DRAG_CLASS } from "./window-drag";

function titleBar() {
  document.body.innerHTML = `
    <header class="${DRAG_CLASS}">
      <span id="empty">Project › Workspace</span>
      <button id="button"><span id="icon">+</span></button>
      <span class="${NO_DRAG_CLASS}" id="pills"><span id="pill">1</span></span>
      <div role="tab" id="tab">Tab</div>
    </header>
    <main id="panel">terminal</main>`;
  const get = (id: string): HTMLElement => {
    const element = document.getElementById(id);
    if (element === null) throw new Error(id);
    return element;
  };
  return get;
}

function host() {
  return {
    startDragging: vi.fn(() => Promise.resolve()),
    toggleMaximize: vi.fn(() => Promise.resolve()),
    systemMenu: vi.fn<(x: number, y: number) => Promise<void>>(() => Promise.resolve()),
  };
}

let remove: (() => void) | undefined;
afterEach(() => {
  remove?.();
  remove = undefined;
  document.body.innerHTML = "";
});

describe("the title bar moves the window without CSS app regions", () => {
  it("only_the_title_bars_empty_space_moves_the_window", () => {
    const get = titleBar();
    expect(isDragTarget(get("empty"))).toBe(true);
    expect(isDragTarget(get("button"))).toBe(false);
    expect(isDragTarget(get("icon"))).toBe(false);
    expect(isDragTarget(get("pill"))).toBe(false);
    expect(isDragTarget(get("tab"))).toBe(false);
    expect(isDragTarget(get("panel"))).toBe(false);
    expect(isDragTarget(null)).toBe(false);
  });

  it("a_press_drags_a_double_press_maximizes_a_right_click_opens_the_system_menu", () => {
    const get = titleBar();
    const window = host();
    remove = installWindowDrag(document, window);
    const press = (target: HTMLElement, init: MouseEventInit) => {
      const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(event);
      return event;
    };
    expect(press(get("empty"), { button: 0, detail: 1 }).defaultPrevented).toBe(true);
    expect(window.startDragging).toHaveBeenCalledTimes(1);
    press(get("empty"), { button: 0, detail: 2 });
    expect(window.toggleMaximize).toHaveBeenCalledTimes(1);
    // The right button, a button inside the bar and the panels are left alone.
    press(get("empty"), { button: 2, detail: 1 });
    press(get("button"), { button: 0, detail: 1 });
    press(get("panel"), { button: 0, detail: 1 });
    expect(window.startDragging).toHaveBeenCalledTimes(1);
    const menu = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 40,
      clientY: 12,
    });
    get("empty").dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
    expect(window.systemMenu).toHaveBeenCalledWith(40, 12);
    // A right-click on a pill keeps its own menu.
    const pillMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    get("pill").dispatchEvent(pillMenu);
    expect(pillMenu.defaultPrevented).toBe(false);
    expect(window.systemMenu).toHaveBeenCalledTimes(1);
  });

  it("removing_the_listeners_stops_them", () => {
    const get = titleBar();
    const window = host();
    installWindowDrag(document, window)();
    get("empty").dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0, detail: 1 }),
    );
    expect(window.startDragging).not.toHaveBeenCalled();
  });
});
