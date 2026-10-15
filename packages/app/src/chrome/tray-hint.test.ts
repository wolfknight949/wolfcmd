// N-01: the one hint about the tray: shown the first time closing hides the window, never again.
import { afterEach, describe, expect, it, vi } from "vitest";

import { complete, createSettingsStore } from "../store/settings";
import { dismissTrayHint, installTrayHint, trayHint, trayHintText } from "./tray-hint";

/** A stand-in for the core's `window-hidden` event: `hide(tray)` fires it. */
function hiddenEvents() {
  let listener: ((tray: boolean) => void) | undefined;
  return {
    onHidden: (next: (tray: boolean) => void) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    hide: (tray = true) => {
      listener?.(tray);
    },
  };
}

afterEach(() => {
  dismissTrayHint();
});

describe("N-01 the tray hint", () => {
  it("n01_tray_hint: shows the first time the window hides, and is remembered in the settings", async () => {
    const save = vi.fn(() => Promise.resolve());
    const settings = createSettingsStore(complete({}), save);
    const events = hiddenEvents();
    const stop = installTrayHint(settings, events.onHidden);
    expect(trayHint.getState()).toBeNull();
    events.hide();
    expect(trayHint.getState()).toBe(trayHintText(true));
    expect(trayHint.getState()).toContain("Ctrl+Q");
    expect(settings.getState().window.tray_hint_shown).toBe(true);
    await settings.saved();
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        window: { close_to_tray: true, tray_hint_shown: true, confirm_close: true },
      }),
    );
    // Closed by the user; the window hides again: never again.
    dismissTrayHint();
    events.hide();
    expect(trayHint.getState()).toBeNull();
    expect(save).toHaveBeenCalledTimes(1);
    stop();
  });

  it("n01_tray_hint: never shows once it was shown in an earlier run", () => {
    const save = vi.fn(() => Promise.resolve());
    const settings = createSettingsStore(complete({ window: { tray_hint_shown: true } }), save);
    const events = hiddenEvents();
    installTrayHint(settings, events.onHidden);
    events.hide();
    expect(trayHint.getState()).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it("n01_tray_hint: on macOS the window waits in the Dock, and Cmd+Q quits", () => {
    const settings = createSettingsStore(complete({}), () => Promise.resolve());
    const events = hiddenEvents();
    installTrayHint(settings, events.onHidden);
    events.hide(false);
    expect(trayHint.getState()).toBe("WolfCmd is still running. Quit with Cmd+Q.");
  });
});
