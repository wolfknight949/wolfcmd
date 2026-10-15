import { describe, expect, it } from "vitest";

import { isTopOverlay, modalOpen, openOverlay } from "./overlays";

describe("overlay registry", () => {
  it("knows the overlay on top, oldest first", () => {
    const menu = openOverlay("menu");
    const other = openOverlay("menu");
    expect(isTopOverlay(other.id)).toBe(true);
    expect(isTopOverlay(menu.id)).toBe(false);
    other.close();
    expect(isTopOverlay(menu.id)).toBe(true);
    menu.close();
    expect(isTopOverlay(menu.id)).toBe(false);
    expect(isTopOverlay(undefined)).toBe(false);
  });

  it("a dialog is modal while open; closing twice is harmless", () => {
    const dialog = openOverlay("dialog");
    expect(modalOpen()).toBe(true);
    dialog.close();
    dialog.close();
    expect(modalOpen()).toBe(false);
  });
});
