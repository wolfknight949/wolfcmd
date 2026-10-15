// N-02: the Kitty keyboard protocol ("progressive enhancement",
// https://sw.kovidgoyal.net/kitty/keyboard-protocol/), for programs that ask for it, while the
// `terminal.kitty_keyboard` setting is on (off by default: not yet checked live with every
// agent CLI through ConPTY). Off until the program pushes flags (`CSI > flags u`); then keys are
// encoded here instead of xterm's legacy bytes. Pure: the terminal view keeps the stacks and
// writes what this returns.
import { isImeKey, isOneCharacter, typesAltGrCharacter } from "@wolfcmd/ui-kit";

/** The enhancement flags. */
export const KITTY = {
  /** Esc, Ctrl/Alt chords and keys without text as `CSI … u` (Enter/Tab/Backspace stay legacy). */
  disambiguate: 1,
  /** Repeat and release events. */
  eventTypes: 2,
  /** The shifted key and the base-layout (US) key. */
  alternateKeys: 4,
  /** Every key, text keys and modifiers included, as an escape code. */
  allKeys: 8,
  /** The text a key types, with `allKeys`. */
  text: 16,
} as const;

/** Every flag WolfCmd implements; others are dropped from requests. */
const KITTY_SUPPORTED = 31;
/** How many pushes a stack keeps; the oldest goes first. */
export const KITTY_STACK_LIMIT = 16;

/** One screen's stack of flag sets; the last one is in effect (none: protocol off). */
export type KittyStack = readonly number[];

export function kittyFlags(stack: KittyStack): number {
  return stack.at(-1) ?? 0;
}

/** `CSI > flags u`. */
export function kittyPush(stack: KittyStack, flags: number): KittyStack {
  const next = [...stack, flags & KITTY_SUPPORTED];
  return next.length > KITTY_STACK_LIMIT ? next.slice(next.length - KITTY_STACK_LIMIT) : next;
}

/** `CSI < count u` (default 1). Popping everything turns the protocol off. */
export function kittyPop(stack: KittyStack, count: number): KittyStack {
  return stack.slice(0, Math.max(0, stack.length - Math.max(1, count)));
}

/** `CSI = flags ; mode u`: 1 sets the flags, 2 adds them, 3 removes them. */
export function kittySet(stack: KittyStack, flags: number, mode: number): KittyStack {
  const current = kittyFlags(stack);
  const wanted = flags & KITTY_SUPPORTED;
  const next = mode === 2 ? current | wanted : mode === 3 ? current & ~wanted : wanted;
  return stack.length === 0 ? [next] : [...stack.slice(0, -1), next];
}

/** The answer to `CSI ? u`. */
export function kittyQueryReply(stack: KittyStack): string {
  return `\x1b[?${String(kittyFlags(stack))}u`;
}

/** A CSI parameter from xterm's parser (sub-parameters: the first one). */
export function csiParam(
  params: readonly (number | readonly number[])[],
  index: number,
): number | undefined {
  const value = params.at(index);
  if (value === undefined) return undefined;
  return typeof value === "number" ? value : value.at(0);
}

/** What the encoder reads from a DOM key event. */
export interface KittyKeyEvent {
  readonly type: string;
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly repeat: boolean;
  readonly isComposing?: boolean;
  readonly getModifierState?: (key: string) => boolean;
}

/** US layout characters (unshifted, shifted) by physical key: the protocol's "base layout key". */
const US_SYMBOLS: Readonly<Record<string, string>> = {
  Backquote: "`~",
  Minus: "-_",
  Equal: "=+",
  BracketLeft: "[{",
  BracketRight: "]}",
  Backslash: "\\|",
  IntlBackslash: "\\|",
  Semicolon: ";:",
  Quote: "'\"",
  Comma: ",<",
  Period: ".>",
  Slash: "/?",
  Space: "  ",
  Digit1: "1!",
  Digit2: "2@",
  Digit3: "3#",
  Digit4: "4$",
  Digit5: "5%",
  Digit6: "6^",
  Digit7: "7&",
  Digit8: "8*",
  Digit9: "9(",
  Digit0: "0)",
};

/** The US layout's unshifted character for a physical key, if it types one. */
export function usBaseKey(code: string): string | undefined {
  const letter = /^Key([A-Z])$/.exec(code)?.[1];
  if (letter !== undefined) return letter.toLowerCase();
  return US_SYMBOLS[code]?.charAt(0);
}

/** Keys sent as `CSI 1 ; mods <letter>` (`CSI <letter>` without modifiers). */
const LETTER_KEYS: Readonly<Record<string, string>> = {
  ArrowUp: "A",
  ArrowDown: "B",
  ArrowRight: "C",
  ArrowLeft: "D",
  End: "F",
  Home: "H",
  F1: "P",
  F2: "Q",
  F4: "S",
};

/** Keys sent as `CSI <number> ; mods ~`. */
const TILDE_KEYS: Readonly<Record<string, number>> = {
  Insert: 2,
  Delete: 3,
  PageUp: 5,
  PageDown: 6,
  F3: 13,
  F5: 15,
  F6: 17,
  F7: 18,
  F8: 19,
  F9: 20,
  F10: 21,
  F11: 23,
  F12: 24,
};

/** Keys without text sent as `CSI <number> ; mods u`. */
const NUMBERED_KEYS: Readonly<Record<string, number>> = {
  Escape: 27,
  Enter: 13,
  Tab: 9,
  Backspace: 127,
  PrintScreen: 57361,
  Pause: 57362,
  ContextMenu: 57363,
};

/** Lock and modifier keys: reported only with `allKeys`. */
const LOCK_KEYS: Readonly<Record<string, number>> = {
  CapsLock: 57358,
  ScrollLock: 57359,
  NumLock: 57360,
};
const MODIFIER_CODES: Readonly<Record<string, number>> = {
  ShiftLeft: 57441,
  ControlLeft: 57442,
  AltLeft: 57443,
  MetaLeft: 57444,
  ShiftRight: 57447,
  ControlRight: 57448,
  AltRight: 57449,
  MetaRight: 57450,
};
/** AltGr itself (ISO_Level3_Shift). */
const ALT_GRAPH = 57453;

/** The numeric keypad by physical key (NumLock on, or keys that never change). */
const KEYPAD_CODES: Readonly<Record<string, number>> = {
  Numpad0: 57399,
  Numpad1: 57400,
  Numpad2: 57401,
  Numpad3: 57402,
  Numpad4: 57403,
  Numpad5: 57404,
  Numpad6: 57405,
  Numpad7: 57406,
  Numpad8: 57407,
  Numpad9: 57408,
  NumpadDecimal: 57409,
  NumpadDivide: 57410,
  NumpadMultiply: 57411,
  NumpadSubtract: 57412,
  NumpadAdd: 57413,
  NumpadEnter: 57414,
  NumpadEqual: 57415,
  NumpadComma: 57416,
};
/** The keypad's navigation keys (NumLock off), by the key they act as. */
const KEYPAD_KEYS: Readonly<Record<string, number>> = {
  ArrowLeft: 57417,
  ArrowRight: 57418,
  ArrowUp: 57419,
  ArrowDown: 57420,
  PageUp: 57421,
  PageDown: 57422,
  Home: 57423,
  End: 57424,
  Insert: 57425,
  Delete: 57426,
  Clear: 57427,
};

const F13 = 57376;

/** The protocol's number for a key that types no text, if it has one. */
function functionalNumber(event: KittyKeyEvent): number | undefined {
  if (event.code.startsWith("Numpad")) {
    return KEYPAD_KEYS[event.key] ?? KEYPAD_CODES[event.code];
  }
  const high = /^F(1[3-9]|2[0-4])$/.exec(event.key)?.[1];
  if (high !== undefined) return F13 + Number(high) - 13;
  return NUMBERED_KEYS[event.key];
}

/** The modifier bits (shift 1, alt 2, ctrl 4, super 8, caps lock 64, num lock 128). */
function modifierBits(event: KittyKeyEvent, altGr: boolean, locks: boolean): number {
  let bits = 0;
  if (event.shiftKey) bits |= 1;
  if (event.altKey && !altGr) bits |= 2;
  if (event.ctrlKey && !altGr) bits |= 4;
  if (event.metaKey) bits |= 8;
  if (locks && (event.getModifierState?.("CapsLock") ?? false)) bits |= 64;
  if (locks && (event.getModifierState?.("NumLock") ?? false)) bits |= 128;
  return bits;
}

/** Shift alone doesn't stop a key from being text; Alt, Ctrl and Super do. */
const CHORD_BITS = 2 | 4 | 8;

const codepoint = (text: string): number => text.codePointAt(0) ?? 0;

/**
 * N-02: the bytes for a key event under the Kitty keyboard protocol with `flags`, or
 * `undefined` when the key keeps its legacy encoding (xterm sends it as usual). Never for an
 * IME's keys (composition is the IME's) or a dead key (the next key types the character).
 *
 * Windows specifics: AltGr (reported as Ctrl+Alt) types text, so its Ctrl and Alt are not
 * modifiers; a Ctrl/Alt chord on a non-Latin layout (Ukrainian Ctrl+С) is reported with the
 * physical key's US character (`c`), like Windows' own shortcuts, so ^C-style keys keep working.
 */
export function encodeKittyKey(event: KittyKeyEvent, flags: number): string | undefined {
  if (flags === 0 || isImeKey(event) || event.key === "Dead") return undefined;
  const release = event.type === "keyup";
  const events = (flags & KITTY.eventTypes) !== 0;
  if (release && !events) return undefined;
  if (event.type !== "keydown" && !release) return undefined;
  const allKeys = (flags & KITTY.allKeys) !== 0;
  const altGr = typesAltGrCharacter(event);
  const mods = modifierBits(event, altGr, allKeys);
  const kind = release ? 3 : event.repeat ? 2 : 1;
  const modField = (force: boolean): string => {
    const eventPart = events && kind !== 1 ? `:${String(kind)}` : "";
    if (!force && mods === 0 && eventPart === "") return "";
    return `${String(mods + 1)}${eventPart}`;
  };
  const csiU = (number: number, alternates = "", text = ""): string => {
    const field = modField(text !== "");
    const tail = text === "" ? (field === "" ? "" : `;${field}`) : `;${field};${text}`;
    return `\x1b[${String(number)}${alternates}${tail}u`;
  };

  // Modifier and lock keys themselves: only when every key is reported.
  if (event.key === "AltGraph") return allKeys ? csiU(ALT_GRAPH) : undefined;
  const modifier = MODIFIER_CODES[event.code] ?? LOCK_KEYS[event.key];
  if (modifier !== undefined) return allKeys ? csiU(modifier) : undefined;

  const letter = LETTER_KEYS[event.key];
  if (letter !== undefined && !event.code.startsWith("Numpad")) {
    if (mods === 0 && kind === 1 && !allKeys) return undefined; // legacy (cursor key mode)
    const field = modField(false);
    return `\x1b[${field === "" ? "" : `1;${field}`}${letter}`;
  }
  const tilde = TILDE_KEYS[event.key];
  if (tilde !== undefined && !event.code.startsWith("Numpad")) {
    if (mods === 0 && kind === 1 && !allKeys) return undefined;
    const field = modField(false);
    return `\x1b[${String(tilde)}${field === "" ? "" : `;${field}`}~`;
  }

  const text = isOneCharacter(event.key) ? event.key : undefined;
  const functional = functionalNumber(event);
  if (functional !== undefined && text === undefined) {
    // Enter, Tab and Backspace keep their bytes unmodified, and have no release events, so a
    // shell still works after a program that crashed with the protocol on.
    const legacy = event.key === "Enter" || event.key === "Tab" || event.key === "Backspace";
    if (legacy && !event.code.startsWith("Numpad") && !allKeys && (mods === 0 || release)) {
      return undefined;
    }
    return csiU(functional);
  }
  if (text === undefined) return undefined;

  // A key that types text.
  const chord = (mods & CHORD_BITS) !== 0;
  if (!allKeys && !chord && !release) return undefined; // the text itself (legacy)
  const base = usBaseKey(event.code);
  const number = textKeyNumber(event, text, base, chord);
  const alternates =
    (flags & KITTY.alternateKeys) === 0 ? "" : alternateKeys(event, text, base, number);
  const typed = (flags & KITTY.text) !== 0 && allKeys && !chord && !release;
  return csiU(number, alternates, typed ? String(codepoint(text)) : "");
}

/**
 * The number of a key that types `text`: the keypad's own, else the unshifted key. A Ctrl/Alt
 * chord on a non-Latin layout uses the US layout's character of the same physical key; a
 * shifted symbol uses the US layout's unshifted one (the current layout's isn't known).
 */
function textKeyNumber(
  event: KittyKeyEvent,
  text: string,
  base: string | undefined,
  chord: boolean,
): number {
  const keypad = KEYPAD_CODES[event.code];
  if (keypad !== undefined) return keypad;
  if (chord && codepoint(text) > 0x7f && base !== undefined) return codepoint(base);
  if (!event.shiftKey) return codepoint(text);
  const lower = text.toLowerCase();
  if (lower !== text) return codepoint(lower);
  return base === undefined ? codepoint(text) : codepoint(base);
}

/** `:shifted:base` (flag 4): each only when it differs from the key's number. */
function alternateKeys(
  event: KittyKeyEvent,
  text: string,
  base: string | undefined,
  number: number,
): string {
  const shifted = event.shiftKey && codepoint(text) !== number ? String(codepoint(text)) : "";
  const layout = base !== undefined && codepoint(base) !== number ? String(codepoint(base)) : "";
  if (layout !== "") return `:${shifted}:${layout}`;
  return shifted === "" ? "" : `:${shifted}`;
}
