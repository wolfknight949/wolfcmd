import { describe, expect, it, vi } from "vitest";

import type { Actions } from "./actions";
import { closeSettings, settingsOpen } from "./chrome/settings-open";
import { type KeyHost, shortcutFor } from "./keys";

function host(focused: string | null) {
  const calls = {
    cycleTab: vi.fn(),
    newTab: vi.fn(),
    newTerminal: vi.fn(),
    newWorkspace: vi.fn(),
    closePanel: vi.fn(),
    activateTabNumber: vi.fn(),
    fontSize: vi.fn(),
    focusNeighbor: vi.fn(),
    toggleMaximize: vi.fn(),
    duplicateTab: vi.fn(),
    quit: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
  };
  const actions = { ...calls } as unknown as Actions;
  const keys: KeyHost = {
    actions,
    focusedPanel: () => focused ?? undefined,
    shownTab: () => "t1",
    focusNeighbor: calls.focusNeighbor,
  };
  return { calls, keys };
}

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

describe("N-03 shortcuts", () => {
  it("map the workspace, panel and font keys", () => {
    const { calls, keys } = host("p1");
    shortcutFor(key({ key: "Tab", code: "Tab", ctrlKey: true, shiftKey: true }), keys)?.();
    expect(calls.cycleTab).toHaveBeenCalledWith(-1);
    shortcutFor(key({ key: "T", code: "KeyT", ctrlKey: true, shiftKey: true }), keys)?.();
    expect(calls.newTab).toHaveBeenCalled();
    shortcutFor(key({ key: "+", code: "Equal", altKey: true, shiftKey: true }), keys)?.();
    expect(calls.newTerminal).toHaveBeenCalledWith("right");
    shortcutFor(key({ key: "W", code: "KeyW", ctrlKey: true, shiftKey: true }), keys)?.();
    expect(calls.closePanel).toHaveBeenCalledWith("p1");
    shortcutFor(key({ key: "ArrowLeft", code: "ArrowLeft", altKey: true }), keys)?.();
    expect(calls.focusNeighbor).toHaveBeenCalledWith("left");
    shortcutFor(key({ key: "3", code: "Digit3", ctrlKey: true, altKey: true }), keys)?.();
    expect(calls.activateTabNumber).toHaveBeenCalledWith(3);
    shortcutFor(key({ key: "-", code: "Minus", ctrlKey: true }), keys)?.();
    expect(calls.fontSize).toHaveBeenCalledWith(-1);
  });

  it("n03_maximize_key: Ctrl+Shift+Enter maximizes the focused panel, Ctrl+Shift+D duplicates the tab", () => {
    const { calls, keys } = host("p1");
    shortcutFor(key({ key: "Enter", code: "Enter", ctrlKey: true, shiftKey: true }), keys)?.();
    expect(calls.toggleMaximize).toHaveBeenCalledWith("p1");
    shortcutFor(key({ key: "D", code: "KeyD", ctrlKey: true, shiftKey: true }), keys)?.();
    expect(calls.duplicateTab).toHaveBeenCalledWith("t1");
    // Without a panel there is nothing to maximize; Ctrl+Enter alone stays the terminal's.
    const { keys: empty } = host(null);
    expect(
      shortcutFor(key({ key: "Enter", code: "Enter", ctrlKey: true, shiftKey: true }), empty),
    ).toBeUndefined();
    expect(shortcutFor(key({ key: "Enter", code: "Enter", ctrlKey: true }), keys)).toBeUndefined();
  });

  it("leave every other key to the terminal", () => {
    const { keys } = host(null);
    expect(shortcutFor(key({ key: "c", code: "KeyC", ctrlKey: true }), keys)).toBeUndefined();
    expect(shortcutFor(key({ key: "Enter", code: "Enter", shiftKey: true }), keys)).toBeUndefined();
    // Nothing to close without a focused panel.
    expect(
      shortcutFor(key({ key: "W", code: "KeyW", ctrlKey: true, shiftKey: true }), keys),
    ).toBeUndefined();
  });
});

describe("N-07 Settings shortcut", () => {
  it("n07_settings_key: Ctrl+, opens Settings, returning the focus to what had it", () => {
    const { keys } = host("p1");
    const field = document.createElement("textarea");
    document.body.append(field);
    field.focus();
    shortcutFor(key({ key: ",", code: "Comma", ctrlKey: true }), keys)?.();
    expect(settingsOpen.getState()).toEqual({ open: true, returnTo: field });
    // Ctrl+Shift+, and Alt+, stay the terminal's.
    expect(
      shortcutFor(key({ key: "<", code: "Comma", ctrlKey: true, shiftKey: true }), keys),
    ).toBeUndefined();
    expect(shortcutFor(key({ key: ",", code: "Comma", altKey: true }), keys)).toBeUndefined();
    closeSettings();
    expect(settingsOpen.getState().open).toBe(false);
    field.remove();
  });
});

describe("N-01 Quit shortcut", () => {
  it("n01_quit_key: Ctrl+Q quits for real; Ctrl+Shift+Q, Alt+Q and Q stay the terminal's", () => {
    const { calls, keys } = host("p1");
    shortcutFor(key({ key: "q", code: "KeyQ", ctrlKey: true }), keys)?.();
    expect(calls.quit).toHaveBeenCalledTimes(1);
    // Another layout's Q (AZERTY puts it on the A key) is still Q.
    shortcutFor(key({ key: "q", code: "KeyA", ctrlKey: true }), keys)?.();
    expect(calls.quit).toHaveBeenCalledTimes(2);
    expect(
      shortcutFor(key({ key: "Q", code: "KeyQ", ctrlKey: true, shiftKey: true }), keys),
    ).toBeUndefined();
    expect(shortcutFor(key({ key: "q", code: "KeyQ", altKey: true }), keys)).toBeUndefined();
    expect(shortcutFor(key({ key: "q", code: "KeyQ" }), keys)).toBeUndefined();
  });
});

describe("N-11 undo keys", () => {
  it("n11_undo_keys: Ctrl+Shift+Z undoes and Ctrl+Shift+Y redoes; Ctrl+Z and Ctrl+Y stay the terminal's", () => {
    const { calls, keys } = host("p1");
    shortcutFor(key({ key: "Z", code: "KeyZ", ctrlKey: true, shiftKey: true }), keys)?.();
    expect(calls.undo).toHaveBeenCalledOnce();
    shortcutFor(key({ key: "Y", code: "KeyY", ctrlKey: true, shiftKey: true }), keys)?.();
    expect(calls.redo).toHaveBeenCalledOnce();
    expect(shortcutFor(key({ key: "z", code: "KeyZ", ctrlKey: true }), keys)).toBeUndefined();
    expect(shortcutFor(key({ key: "y", code: "KeyY", ctrlKey: true }), keys)).toBeUndefined();
  });
});
