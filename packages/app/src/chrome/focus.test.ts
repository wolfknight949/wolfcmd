import { describe, expect, it } from "vitest";

import { focusShownTerminal, keepKeyboard } from "./focus";

describe("N-06 focus after a menu opened a panel", () => {
  it("n06_focus_terminal: the shown tab's focused terminal gets the keyboard", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <div data-panel="hidden" data-focused class="invisible"><textarea class="xterm-helper-textarea"></textarea></div>
      <div data-panel="other"><textarea class="xterm-helper-textarea"></textarea></div>
      <div data-panel="shown" data-focused><textarea class="xterm-helper-textarea"></textarea></div>`;
    document.body.append(root);
    expect(focusShownTerminal(root)).toBe(true);
    expect(document.activeElement?.parentElement?.dataset.panel).toBe("shown");
    root.remove();
    expect(focusShownTerminal(document.createElement("div"))).toBe(false);
  });
});

describe("N-02 a press on the chrome keeps the keyboard", () => {
  it("n02_keep_keyboard: a left press on a button leaves the focus in the terminal", () => {
    const terminal = document.createElement("textarea");
    const button = document.createElement("button");
    button.addEventListener("mousedown", keepKeyboard);
    document.body.append(terminal, button);
    terminal.focus();
    const left = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
    button.dispatchEvent(left);
    expect(left.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(terminal);
    // Other buttons keep their own meaning (a middle press closes a tab, a right one a menu).
    const middle = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 1 });
    button.dispatchEvent(middle);
    expect(middle.defaultPrevented).toBe(false);
    terminal.remove();
    button.remove();
  });
});
