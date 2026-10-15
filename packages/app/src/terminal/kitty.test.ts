import { describe, expect, it } from "vitest";

import {
  csiParam,
  encodeKittyKey,
  KITTY,
  KITTY_STACK_LIMIT,
  type KittyKeyEvent,
  kittyFlags,
  kittyPop,
  kittyPush,
  kittyQueryReply,
  kittySet,
  usBaseKey,
} from "./kitty";

type Mods = Partial<Record<"ctrl" | "shift" | "alt" | "altGraph" | "repeat" | "up", boolean>>;

/** A key event as Chromium on Windows reports it. */
function press(code: string, key: string, mods: Mods = {}): KittyKeyEvent {
  return {
    type: mods.up === true ? "keyup" : "keydown",
    key,
    code,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
    metaKey: false,
    repeat: mods.repeat ?? false,
    getModifierState: (name) => name === "AltGraph" && (mods.altGraph ?? false),
  };
}

const D = KITTY.disambiguate;
const ESC = "\x1b";

describe("N-02 Kitty keyboard flag stacks", () => {
  it("n02_kitty_push_pop_set_and_query", () => {
    expect(kittyFlags([])).toBe(0);
    let stack = kittyPush([], 1);
    expect(kittyFlags(stack)).toBe(1);
    stack = kittyPush(stack, 0b11111 | 32);
    expect(kittyFlags(stack)).toBe(31); // unsupported bits dropped
    expect(kittyQueryReply(stack)).toBe(`${ESC}[?31u`);
    stack = kittyPop(stack, 1);
    expect(kittyFlags(stack)).toBe(1);
    stack = kittySet(stack, 8, 2);
    expect(kittyFlags(stack)).toBe(9);
    stack = kittySet(stack, 1, 3);
    expect(kittyFlags(stack)).toBe(8);
    stack = kittySet(stack, 3, 1);
    expect(kittyFlags(stack)).toBe(3);
    // `CSI < u` pops one; popping everything turns the protocol off.
    expect(kittyFlags(kittyPop(stack, 0))).toBe(0);
    expect(kittyFlags(kittyPop(stack, 99))).toBe(0);
    expect(kittyQueryReply([])).toBe(`${ESC}[?0u`);
    // Setting with an empty stack sets the current flags.
    expect(kittyFlags(kittySet([], 1, 1))).toBe(1);
  });

  it("n02_kitty_stack_evicts_the_oldest", () => {
    let stack = kittyPush([], 1);
    for (let i = 0; i < KITTY_STACK_LIMIT; i += 1) stack = kittyPush(stack, 2);
    expect(stack).toHaveLength(KITTY_STACK_LIMIT);
    expect(stack).not.toContain(1);
  });

  it("n02_kitty_reads_csi_params", () => {
    expect(csiParam([1], 0)).toBe(1);
    expect(csiParam([[3, 4]], 0)).toBe(3);
    expect(csiParam([1], 1)).toBeUndefined();
  });
});

describe("N-02 Kitty keyboard encoding", () => {
  it("n02_kitty_off_keeps_legacy_bytes", () => {
    expect(encodeKittyKey(press("Enter", "Enter", { shift: true }), 0)).toBeUndefined();
    expect(encodeKittyKey(press("KeyC", "c", { ctrl: true }), 0)).toBeUndefined();
  });

  it("n02_kitty_disambiguates_escape_and_chords", () => {
    expect(encodeKittyKey(press("Escape", "Escape"), D)).toBe(`${ESC}[27u`);
    expect(encodeKittyKey(press("KeyC", "c", { ctrl: true }), D)).toBe(`${ESC}[99;5u`);
    expect(encodeKittyKey(press("KeyC", "C", { ctrl: true, shift: true }), D)).toBe(`${ESC}[99;6u`);
    expect(encodeKittyKey(press("KeyX", "x", { alt: true }), D)).toBe(`${ESC}[120;3u`);
    expect(encodeKittyKey(press("Space", " ", { ctrl: true }), D)).toBe(`${ESC}[32;5u`);
  });

  it("n02_kitty_shift_enter_is_its_own_key", () => {
    expect(encodeKittyKey(press("Enter", "Enter", { shift: true }), D)).toBe(`${ESC}[13;2u`);
    expect(encodeKittyKey(press("Enter", "Enter", { ctrl: true }), D)).toBe(`${ESC}[13;5u`);
    expect(encodeKittyKey(press("Enter", "Enter", { alt: true }), D)).toBe(`${ESC}[13;3u`);
    expect(encodeKittyKey(press("Tab", "Tab", { shift: true }), D)).toBe(`${ESC}[9;2u`);
  });

  it("n02_kitty_leaves_text_and_plain_enter_tab_backspace_legacy", () => {
    for (const [code, key] of [
      ["KeyA", "a"],
      ["Enter", "Enter"],
      ["Tab", "Tab"],
      ["Backspace", "Backspace"],
      ["Space", " "],
    ] as const) {
      expect(encodeKittyKey(press(code, key), D)).toBeUndefined();
    }
    expect(encodeKittyKey(press("KeyA", "A", { shift: true }), D)).toBeUndefined();
    // Unmodified arrows keep xterm's bytes (which follow cursor key mode).
    expect(encodeKittyKey(press("ArrowUp", "ArrowUp"), D)).toBeUndefined();
  });

  it("n02_kitty_function_keys_with_modifiers", () => {
    expect(encodeKittyKey(press("ArrowUp", "ArrowUp", { ctrl: true }), D)).toBe(`${ESC}[1;5A`);
    expect(encodeKittyKey(press("Home", "Home", { shift: true }), D)).toBe(`${ESC}[1;2H`);
    expect(encodeKittyKey(press("Delete", "Delete", { ctrl: true }), D)).toBe(`${ESC}[3;5~`);
    expect(encodeKittyKey(press("F5", "F5", { alt: true }), D)).toBe(`${ESC}[15;3~`);
    expect(encodeKittyKey(press("F1", "F1", { ctrl: true }), D)).toBe(`${ESC}[1;5P`);
    expect(encodeKittyKey(press("F13", "F13"), D)).toBe(`${ESC}[57376u`);
    expect(encodeKittyKey(press("NumpadEnter", "Enter"), D)).toBe(`${ESC}[57414u`);
  });

  it("n02_kitty_event_types", () => {
    const flags = D | KITTY.eventTypes;
    expect(encodeKittyKey(press("KeyA", "a", { up: true }), flags)).toBe(`${ESC}[97;1:3u`);
    expect(encodeKittyKey(press("KeyC", "c", { ctrl: true, repeat: true }), flags)).toBe(
      `${ESC}[99;5:2u`,
    );
    expect(encodeKittyKey(press("ArrowUp", "ArrowUp", { up: true }), flags)).toBe(`${ESC}[1;1:3A`);
    // No release events for Enter, Tab and Backspace (unless every key is reported), and none
    // at all without the flag.
    expect(encodeKittyKey(press("Enter", "Enter", { up: true }), flags)).toBeUndefined();
    expect(encodeKittyKey(press("KeyA", "a", { up: true }), D)).toBeUndefined();
  });

  it("n02_kitty_all_keys_and_text", () => {
    const flags = KITTY.allKeys | KITTY.text;
    expect(encodeKittyKey(press("KeyA", "a"), flags)).toBe(`${ESC}[97;1;97u`);
    expect(encodeKittyKey(press("KeyA", "A", { shift: true }), flags)).toBe(`${ESC}[97;2;65u`);
    expect(encodeKittyKey(press("Enter", "Enter"), KITTY.allKeys)).toBe(`${ESC}[13u`);
    expect(encodeKittyKey(press("ShiftLeft", "Shift", { shift: true }), KITTY.allKeys)).toBe(
      `${ESC}[57441;2u`,
    );
    expect(encodeKittyKey(press("ShiftLeft", "Shift", { shift: true }), D)).toBeUndefined();
    expect(encodeKittyKey(press("ArrowUp", "ArrowUp"), KITTY.allKeys)).toBe(`${ESC}[A`);
    expect(encodeKittyKey(press("Numpad5", "5"), KITTY.allKeys)).toBe(`${ESC}[57404u`);
  });

  it("n02_kitty_alternate_keys", () => {
    const flags = D | KITTY.alternateKeys;
    expect(encodeKittyKey(press("KeyC", "C", { ctrl: true, shift: true }), flags)).toBe(
      `${ESC}[99:67;6u`,
    );
    // Ukrainian Alt+С: reported as the US key of that position (the base key, so no alternate).
    expect(encodeKittyKey(press("KeyC", "с", { alt: true }), flags)).toBe(`${ESC}[99;3u`);
  });

  it("n02_kitty_ukrainian_ctrl_c_is_still_ctrl_c", () => {
    expect(encodeKittyKey(press("KeyC", "с", { ctrl: true }), D)).toBe(`${ESC}[99;5u`);
    // Typing Cyrillic stays text.
    expect(encodeKittyKey(press("KeyC", "с"), D)).toBeUndefined();
  });

  it("n02_kitty_never_takes_ime_dead_or_altgr_keys", () => {
    expect(encodeKittyKey({ ...press("KeyK", "Process"), isComposing: true }, D)).toBeUndefined();
    expect(encodeKittyKey(press("Enter", "Process"), D)).toBeUndefined();
    expect(encodeKittyKey(press("Quote", "Dead"), D)).toBeUndefined();
    // Polish AltGr+Z types ż: text, not Ctrl+Alt+Z.
    const altGr = press("KeyZ", "ż", { ctrl: true, alt: true, altGraph: true });
    expect(encodeKittyKey(altGr, D)).toBeUndefined();
  });

  it("n02_kitty_us_base_keys", () => {
    expect(usBaseKey("KeyQ")).toBe("q");
    expect(usBaseKey("Digit1")).toBe("1");
    expect(usBaseKey("Slash")).toBe("/");
    expect(usBaseKey("ArrowUp")).toBeUndefined();
  });
});
