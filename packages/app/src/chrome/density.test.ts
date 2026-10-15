import { describe, expect, it } from "vitest";

import { COMPACT_BELOW, densityFor, installDensity } from "./density";

describe("N-01 density", () => {
  it("n01_density: compact chrome below 1280 CSS px, regular from there", () => {
    expect(densityFor(COMPACT_BELOW - 1)).toBe("compact");
    expect(densityFor(COMPACT_BELOW)).toBe("regular");
  });

  it("n01_density_live: follows the window as it is resized", () => {
    const root = document.createElement("div");
    const win = { innerWidth: 1000 } as Window & { innerWidth: number };
    const listeners: (() => void)[] = [];
    win.addEventListener = ((_type: string, listener: () => void) => {
      listeners.push(listener);
    }) as Window["addEventListener"];
    win.removeEventListener = (() => undefined) as Window["removeEventListener"];
    installDensity(win, root);
    expect(root.dataset.density).toBe("compact");
    win.innerWidth = 1600;
    for (const listener of listeners) listener();
    expect(root.dataset.density).toBeUndefined();
  });
});
