import { afterEach, describe, expect, it } from "vitest";

import { createFocusReturn } from "./menu-focus";

afterEach(() => {
  document.body.replaceChildren();
});

function setup() {
  const terminal = document.createElement("textarea");
  const menu = document.createElement("div");
  const item = document.createElement("button");
  const elsewhere = document.createElement("input");
  menu.append(item);
  document.body.append(terminal, menu, elsewhere);
  terminal.focus();
  const focus = createFocusReturn();
  focus.remember();
  item.focus();
  return { terminal, menu, item, elsewhere, focus };
}

describe("N-02 the focus after a menu", () => {
  it("n02_focus_return_closing: still in the menu, it goes back at once", () => {
    const { terminal, menu, focus } = setup();
    focus.closing(menu);
    expect(document.activeElement).toBe(terminal);
    expect(focus.untouched()).toBe(true);
  });

  it("n02_focus_return_elsewhere: what took it meanwhile keeps it", () => {
    const { menu, elsewhere, focus } = setup();
    elsewhere.focus();
    focus.closing(menu);
    expect(document.activeElement).toBe(elsewhere);
    expect(focus.untouched()).toBe(false);
  });

  it("n02_focus_return_lost: lost focus counts as untouched and can be given back", () => {
    const { terminal, item, focus } = setup();
    item.remove();
    expect(focus.untouched()).toBe(true);
    expect(focus.giveBack()).toBe(true);
    expect(document.activeElement).toBe(terminal);
  });

  it("n02_focus_return_gone: a terminal that left can't take it", () => {
    const { terminal, menu, item, focus } = setup();
    terminal.remove();
    focus.closing(menu);
    expect(document.activeElement).toBe(item);
    expect(focus.giveBack()).toBe(false);
  });

  it("n02_focus_return_nothing: a menu opened from nothing gives nothing back", () => {
    const menu = document.createElement("div");
    document.body.append(menu);
    const focus = createFocusReturn();
    focus.remember();
    expect(focus.giveBack()).toBe(false);
  });
});
