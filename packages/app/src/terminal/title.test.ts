import { describe, expect, it } from "vitest";

import { displayTitle } from "./title";

describe("terminal titles", () => {
  it("shortens an executable path to the program name", () => {
    expect(displayTitle("C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")).toBe(
      "powershell",
    );
    expect(displayTitle("C:\\Windows\\system32\\cmd.exe")).toBe("cmd");
    expect(displayTitle("/usr/bin/bash.exe")).toBe("bash");
  });

  it("keeps every other title as it is", () => {
    expect(displayTitle("Administrator: Windows PowerShell")).toBe(
      "Administrator: Windows PowerShell",
    );
    expect(displayTitle("C:\\src\\wolfcmd")).toBe("C:\\src\\wolfcmd");
    expect(displayTitle("  vim notes.md  ")).toBe("vim notes.md");
  });

  it("n06_title: leaves out an agent's state glyphs (the panel shows the state itself)", () => {
    expect(displayTitle("◐ add tests")).toBe("add tests");
    expect(displayTitle("✳ Claude Code")).toBe("Claude Code");
    expect(displayTitle("✦ Gemini")).toBe("Gemini");
    expect(displayTitle("⠹ codex  my-repo")).toBe("codex my-repo");
    expect(displayTitle("my-repo ⠼ codex")).toBe("my-repo codex");
    // A glyph inside a word, or a title of only a glyph, stays.
    expect(displayTitle("a◐b")).toBe("a◐b");
    expect(displayTitle("✳")).toBe("✳");
  });
});
