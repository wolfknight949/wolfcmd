import { describe, expect, it } from "vitest";

import { isApple, primaryModifier } from "./platform";

describe("N-02 platform shortcuts", () => {
  it("knows macOS from the platform or the user agent", () => {
    expect(isApple({ platform: "MacIntel" })).toBe(true);
    expect(
      isApple({ platform: "", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)" }),
    ).toBe(true);
    expect(isApple({ platform: "Win32", userAgent: "Mozilla/5.0 (Windows NT 10.0)" })).toBe(false);
    expect(isApple({ platform: "Linux x86_64" })).toBe(false);
  });

  it("uses Cmd on macOS and Ctrl elsewhere", () => {
    const ctrl = { ctrlKey: true, metaKey: false };
    const cmd = { ctrlKey: false, metaKey: true };
    expect(primaryModifier(ctrl, false)).toBe(true);
    expect(primaryModifier(cmd, false)).toBe(false);
    expect(primaryModifier(cmd, true)).toBe(true);
    expect(primaryModifier(ctrl, true)).toBe(false);
  });
});
