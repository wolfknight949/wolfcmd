// Keyboard helpers shared by the app's shortcuts, its text fields and the terminal.
// Pure: they read a key event's fields and never touch the DOM.

/** What the IME guard reads (a DOM `KeyboardEvent`, or React's `event.nativeEvent`). */
export interface ImeKeyInfo {
  readonly key: string;
  readonly isComposing?: boolean;
}

/**
 * The key belongs to an IME (Chinese, Japanese, Korean…): either text is being composed
 * (`isComposing`) or the IME took the key (Chromium reports it as `key: "Process"`, keyCode
 * 229). Enter, Escape and Tab then confirm or cancel the composition: they must never submit,
 * close or run a shortcut.
 */
export function isImeKey(event: ImeKeyInfo): boolean {
  return event.isComposing === true || event.key === "Process";
}

/** One user-perceived character (a surrogate pair counts as one), not a key name like "Enter". */
export function isOneCharacter(key: string): boolean {
  return key !== "" && Array.from(key).length === 1;
}

/** What a chord's letter is read from. */
export interface ChordKeyInfo {
  readonly key: string;
  readonly code: string;
}

const LATIN_LETTER = /^[a-z]$/i;
const ANY_LETTER = /^\p{L}$/u;
const KEY_CODE_LETTER = /^Key([A-Z])$/;

/**
 * The letter (`"A"`…`"Z"`) of a Ctrl / Alt chord, for shortcuts. A Latin layout's own
 * letter wins (`key`: German Z, AZERTY A and Dvorak letters are where their labels are, like
 * Windows' own accelerators); on a non-Latin layout (Ukrainian, Russian, Greek, Hebrew…) the
 * physical key (`code`) answers, so Ctrl+Shift+N works on the key labelled N / Т. A symbol
 * (Dvorak's `'` on the Q key) is no letter.
 */
export function chordLetter(event: ChordKeyInfo): string | undefined {
  if (LATIN_LETTER.test(event.key)) return event.key.toUpperCase();
  if (isOneCharacter(event.key) && !ANY_LETTER.test(event.key)) return undefined;
  return KEY_CODE_LETTER.exec(event.code)?.[1];
}

/** What the AltGr check reads. */
export interface AltGrKeyInfo extends ChordKeyInfo {
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly getModifierState?: (key: string) => boolean;
}

/**
 * Unshifted digit-row symbols of AZERTY layouts (French, Belgian): Ctrl+Alt on those keys
 * reports them without typing anything, so they are not AltGr characters.
 */
const DIGIT_ROW_BASE = new Set(["&", '"', "'", "(", "-", "_", "§", "!"]);
const DIGIT_ROW = /^Digit\d$/;
// German AltGr+2 types ² (a number, but no digit): only letters and 0-9 rule a key out.
const LETTER_OR_NUMBER = /^[\p{L}0-9]$/u;

/**
 * The key types a character with AltGr (Polish ż, German { [ ] } @ €, Czech, Nordic,
 * French…). Windows reports AltGr as Ctrl+Alt, so such a key must stay text: never a Ctrl+Alt
 * shortcut, never a Ctrl+Alt key code. Chromium marks the AltGr key itself (`AltGraph`). Left
 * Ctrl+Alt types the same characters on Windows; that is caught on the digit row (German
 * Ctrl+Alt+7 → `{`), where a symbol no layout has there unshifted, or a dead key, can only
 * come from AltGr. Arrows and other named keys never count (AltGr+Arrow stays a chord).
 */
export function typesAltGrCharacter(event: AltGrKeyInfo): boolean {
  if (!event.ctrlKey || !event.altKey) return false;
  const dead = event.key === "Dead";
  if (!dead && !isOneCharacter(event.key)) return false;
  if (event.getModifierState?.("AltGraph") ?? false) return true;
  if (!DIGIT_ROW.test(event.code) || event.shiftKey) return false;
  return dead || (!LETTER_OR_NUMBER.test(event.key) && !DIGIT_ROW_BASE.has(event.key));
}
