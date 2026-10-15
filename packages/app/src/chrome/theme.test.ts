import { describe, expect, it } from "vitest";

import { installTheme, resolveTheme } from "./theme";

describe("N-01 theme", () => {
  it("n01_theme: Dark and Light as chosen, Auto follows the system", () => {
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("auto", true)).toBe("dark");
    expect(resolveTheme("auto", false)).toBe("light");
  });

  it("n01_theme_live: the setting and, for Auto, the system change it at once", () => {
    const root = document.createElement("html");
    let onSystem = () => undefined as unknown;
    const system = {
      matches: false,
      addEventListener: (_: string, listener: () => void) => {
        onSystem = listener;
      },
      removeEventListener: () => undefined,
    } as unknown as MediaQueryList & { matches: boolean };
    let theme: "dark" | "light" | "auto" = "dark";
    let onSetting = () => undefined as unknown;
    installTheme(
      root,
      system,
      () => theme,
      (listener) => {
        onSetting = listener;
        return () => undefined;
      },
    );
    expect(root.dataset.theme).toBe("dark");
    theme = "auto";
    onSetting();
    expect(root.dataset.theme).toBe("light");
    (system as { matches: boolean }).matches = true;
    onSystem();
    expect(root.dataset.theme).toBe("dark");
  });
});
