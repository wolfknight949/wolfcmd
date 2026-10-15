// N-03: a right-click in a terminal: quick copy/paste on Windows, the menu with Shift, from the
// keyboard or elsewhere, and the program's own while it tracks the mouse.
import { describe, expect, it } from "vitest";

import { editKey, rightClickAction } from "./context-menu";

const click = (fields: Partial<Parameters<typeof rightClickAction>[0]>) =>
  rightClickAction({ keyboard: false, shiftKey: false, tracking: "none", quick: true, ...fields });

describe("N-03 terminal right-click", () => {
  it("n03_right_click: copy or paste on Windows, the menu with Shift or elsewhere", () => {
    expect(click({})).toBe("quick");
    expect(click({ shiftKey: true })).toBe("menu");
    expect(click({ quick: false })).toBe("menu");
    expect(click({ keyboard: true })).toBe("menu");
  });

  it("n03_right_click_tracking: a program tracking the mouse gets it, unless Shift is held", () => {
    expect(click({ tracking: "vt200" })).toBe("program");
    expect(click({ tracking: "any", quick: false })).toBe("program");
    expect(click({ tracking: "any", shiftKey: true })).toBe("menu");
    expect(click({ tracking: "any", keyboard: true })).toBe("menu");
  });

  it("n03_edit_keys: Ctrl+Shift+A selects all, Ctrl+Shift+K clears (Cmd+Shift on macOS)", () => {
    const key = (code: string, fields: Partial<KeyboardEventInit> = {}) =>
      new KeyboardEvent("keydown", {
        key: code.slice(3),
        code,
        ctrlKey: true,
        shiftKey: true,
        ...fields,
      });
    expect(editKey(key("KeyA"), false)).toBe("selectAll");
    expect(editKey(key("KeyK"), false)).toBe("clear");
    expect(editKey(key("KeyA", { shiftKey: false }), false)).toBeUndefined();
    expect(editKey(key("KeyC"), false)).toBeUndefined();
    expect(editKey(key("KeyK", { ctrlKey: false, metaKey: true }), true)).toBe("clear");
    expect(editKey(key("KeyK"), true)).toBeUndefined();
  });
});
