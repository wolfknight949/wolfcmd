// N-02: pasting an image into an agent's panel. The terminal pastes text only, so a clipboard
// that holds a picture and no text would paste nothing. In an agent panel WolfCmd instead
// presses the agent's own image-paste key (registry `image_paste`: Claude Code `alt+v` on
// Windows, Codex `ctrl+v`; `AgentInfo.imagePaste`), and the agent reads the clipboard itself.
// Pure, unit-tested; the terminal view writes the bytes.
import { encodeKittyKey, type KittyKeyEvent } from "./kitty";

/** What the paste decision reads from a `ClipboardEvent`'s data. */
export interface ClipboardKinds {
  readonly types: readonly string[];
  readonly items?: ArrayLike<{ readonly kind: string; readonly type: string }>;
}

/** The clipboard holds a picture (a screenshot, a copied image): an `image/*` item. */
export function hasImage(data: ClipboardKinds | null | undefined): boolean {
  if (!data) return false;
  const items = data.items === undefined ? [] : Array.from(data.items);
  if (items.some((item) => item.kind === "file" && item.type.startsWith("image/"))) return true;
  return data.types.some((type) => type.startsWith("image/"));
}

/** A key like `alt+v` / `ctrl+v` as the key event the user's own press would be. */
export function chordEvent(chord: string): KittyKeyEvent | undefined {
  const match = /^(alt|ctrl)\+([a-z])$/.exec(chord.trim().toLowerCase());
  if (!match) return undefined;
  const [, modifier, letter = ""] = match;
  return {
    type: "keydown",
    key: letter,
    code: `Key${letter.toUpperCase()}`,
    ctrlKey: modifier === "ctrl",
    shiftKey: false,
    altKey: modifier === "alt",
    metaKey: false,
    repeat: false,
  };
}

/**
 * The bytes the agent reads as `chord`: the Kitty keyboard protocol's encoding when the agent
 * turned it on (`flags`), else the legacy ones (`alt+v` = Esc v, `ctrl+v` = 0x16, which
 * ConPTY hands to the agent as that key). `undefined` for a key WolfCmd can't press.
 */
export function chordBytes(chord: string, flags: number): string | undefined {
  const event = chordEvent(chord);
  if (!event) return undefined;
  const kitty = encodeKittyKey(event, flags);
  if (kitty !== undefined) return kitty;
  if (event.altKey) return `\x1b${event.key}`;
  return String.fromCharCode(event.key.charCodeAt(0) - 96);
}
