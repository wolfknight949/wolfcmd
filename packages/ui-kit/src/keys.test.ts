import { describe, expect, it } from "vitest";

import { chordLetter, isImeKey, isOneCharacter, typesAltGrCharacter } from "./keys";

const chord = (
  code: string,
  key: string,
  mods: Partial<Record<"ctrl" | "alt" | "shift" | "altGraph", boolean>> = {},
) => ({
  code,
  key,
  ctrlKey: mods.ctrl ?? false,
  altKey: mods.alt ?? false,
  shiftKey: mods.shift ?? false,
  getModifierState: (name: string) => name === "AltGraph" && (mods.altGraph ?? false),
});

describe("IME keys", () => {
  it("ime_keys_are_composing_or_process", () => {
    expect(isImeKey({ key: "Enter", isComposing: true })).toBe(true);
    // Chromium reports keys the IME takes as "Process" (keyCode 229), even the first one.
    expect(isImeKey({ key: "Process", isComposing: false })).toBe(true);
    expect(isImeKey({ key: "Process" })).toBe(true);
    expect(isImeKey({ key: "Enter", isComposing: false })).toBe(false);
    expect(isImeKey({ key: "a" })).toBe(false);
  });

  it("one_character_counts_surrogate_pairs_once", () => {
    expect(isOneCharacter("a")).toBe(true);
    expect(isOneCharacter("ж")).toBe(true);
    expect(isOneCharacter("😀")).toBe(true);
    expect(isOneCharacter("")).toBe(false);
    expect(isOneCharacter("Enter")).toBe(false);
    expect(isOneCharacter("Dead")).toBe(false);
  });
});

describe("chord letters", () => {
  it("latin_layouts_match_by_label", () => {
    expect(chordLetter({ code: "KeyN", key: "N" })).toBe("N");
    expect(chordLetter({ code: "KeyN", key: "n" })).toBe("N");
    // German QWERTZ: the key labelled Z sits where US has Y.
    expect(chordLetter({ code: "KeyY", key: "z" })).toBe("Z");
    // Dvorak: the physical I key types c.
    expect(chordLetter({ code: "KeyI", key: "c" })).toBe("C");
  });

  it("non_latin_layouts_match_by_physical_key", () => {
    // Ukrainian: Т on the N key, С on the C key, Я on the Z key.
    expect(chordLetter({ code: "KeyN", key: "Т" })).toBe("N");
    expect(chordLetter({ code: "KeyC", key: "с" })).toBe("C");
    expect(chordLetter({ code: "KeyZ", key: "я" })).toBe("Z");
    // Greek, Hebrew.
    expect(chordLetter({ code: "KeyP", key: "π" })).toBe("P");
    expect(chordLetter({ code: "KeyT", key: "א" })).toBe("T");
    // No character reported (synthetic events): the physical key.
    expect(chordLetter({ code: "KeyT", key: "" })).toBe("T");
    expect(chordLetter({ code: "KeyT", key: "Unidentified" })).toBe("T");
  });

  it("symbols_are_no_letters", () => {
    expect(chordLetter({ code: "KeyQ", key: "'" })).toBeUndefined();
    expect(chordLetter({ code: "KeyQ", key: "@" })).toBeUndefined();
    expect(chordLetter({ code: "Digit1", key: "1" })).toBeUndefined();
    expect(chordLetter({ code: "Tab", key: "Tab" })).toBeUndefined();
  });
});

describe("AltGr", () => {
  /** The AltGr key (Chromium: Ctrl+Alt plus the `AltGraph` modifier). */
  const altGr = (code: string, key: string) =>
    typesAltGrCharacter(chord(code, key, { ctrl: true, alt: true, altGraph: true }));
  /** Left Ctrl+Alt, which Windows also treats as AltGr. */
  const ctrlAlt = (code: string, key: string) =>
    typesAltGrCharacter(chord(code, key, { ctrl: true, alt: true }));

  it("altgr_key_types_characters", () => {
    expect(altGr("KeyZ", "ż")).toBe(true);
    expect(altGr("KeyQ", "@")).toBe(true);
    expect(altGr("KeyM", "µ")).toBe(true);
    // Czech AltGr+2 is a dead key (ˇ).
    expect(altGr("Digit2", "Dead")).toBe(true);
  });

  it("altgr_arrows_and_plain_chords_stay_chords", () => {
    expect(altGr("ArrowLeft", "ArrowLeft")).toBe(false);
    expect(ctrlAlt("KeyZ", "z")).toBe(false);
    // Ukrainian has no AltGr characters: Ctrl+Alt+Я is a chord.
    expect(ctrlAlt("KeyZ", "я")).toBe(false);
    expect(ctrlAlt("Digit3", "3")).toBe(false);
    expect(typesAltGrCharacter(chord("KeyZ", "ż", { alt: true }))).toBe(false);
  });

  it("left_ctrl_alt_on_the_digit_row_types_altgr_symbols", () => {
    // German: left Ctrl+Alt+7 types {.
    expect(ctrlAlt("Digit7", "{")).toBe(true);
    expect(ctrlAlt("Digit2", "²")).toBe(true);
    expect(ctrlAlt("Digit2", "Dead")).toBe(true);
    // AZERTY reports its unshifted digit-row symbols: still "go to workspace n".
    expect(ctrlAlt("Digit1", "&")).toBe(false);
    expect(ctrlAlt("Digit2", "é")).toBe(false);
    expect(ctrlAlt("Digit5", "(")).toBe(false);
  });
});
