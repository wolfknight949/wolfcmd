import { describe, expect, it } from "vitest";

import { chordBytes, chordEvent, hasImage } from "./image-paste";
import { KITTY } from "./kitty";

describe("N-02 pasting an image into an agent's panel", () => {
  it("N-02 sees a picture in the clipboard (a file item or an image type)", () => {
    expect(hasImage({ types: ["Files"], items: [{ kind: "file", type: "image/png" }] })).toBe(true);
    expect(hasImage({ types: ["image/png"] })).toBe(true);
    expect(
      hasImage({ types: ["text/plain"], items: [{ kind: "string", type: "text/plain" }] }),
    ).toBe(false);
    expect(hasImage({ types: ["Files"], items: [{ kind: "file", type: "application/pdf" }] })).toBe(
      false,
    );
    expect(hasImage(null)).toBe(false);
  });

  it("N-02 presses the agent's key as the user's press would arrive (legacy bytes)", () => {
    // Claude Code on Windows: Alt+V = Esc v. Codex: Ctrl+V = 0x16 (ConPTY hands it over as the key).
    expect(chordBytes("alt+v", 0)).toBe("\x1bv");
    expect(chordBytes("ctrl+v", 0)).toBe("\x16");
    expect(chordBytes("Ctrl+V", 0)).toBe("\x16");
  });

  it("N-02 uses the Kitty keyboard protocol when the agent turned it on", () => {
    expect(chordBytes("ctrl+v", KITTY.disambiguate)).toBe("\x1b[118;5u");
    expect(chordBytes("alt+v", KITTY.disambiguate)).toBe("\x1b[118;3u");
  });

  it("N-02 presses nothing it can't press", () => {
    expect(chordEvent("shift+v")).toBeUndefined();
    expect(chordEvent("ctrl+enter")).toBeUndefined();
    expect(chordBytes("", 0)).toBeUndefined();
    expect(chordEvent("alt+v")).toMatchObject({ key: "v", code: "KeyV", altKey: true });
  });
});
