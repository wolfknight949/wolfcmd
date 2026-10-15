import { describe, expect, it } from "vitest";

import { titleBarLayout } from "./title-bar";

describe("N-01 title bar per OS", () => {
  it("n01_title_bar_windows: our caption buttons, no traffic-light room", () => {
    expect(
      titleBarLayout({
        platform: "Win32",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/141.0",
      }),
    ).toEqual({ captionButtons: true, trafficLights: false });
  });

  it("n01_title_bar_macos: room for the native traffic lights, no caption buttons", () => {
    expect(
      titleBarLayout({
        platform: "MacIntel",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
      }),
    ).toEqual({ captionButtons: false, trafficLights: true });
  });

  it("n01_title_bar_linux: our caption buttons, no traffic-light room", () => {
    expect(
      titleBarLayout({
        platform: "Linux x86_64",
        userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15",
      }),
    ).toEqual({ captionButtons: true, trafficLights: false });
  });
});
