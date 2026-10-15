// N-07: the settings store: complete values, changes that change nothing, saves in order.
import { describe, expect, it, vi } from "vitest";

import { changed, complete, createSettingsStore, stepFontSize } from "./settings";

describe("N-07 settings store", () => {
  it("n07_complete: every key has its default, the default shell automatic", () => {
    const settings = complete({});
    expect(settings.terminal).toEqual({ default_profile: "", kitty_keyboard: false });
    expect(settings.appearance.theme).toBe("dark");
    expect(complete({ terminal: { default_profile: "cmd" } }).terminal.default_profile).toBe("cmd");
  });

  it("n01_complete: closing hides to the tray by default, the hint not shown yet", () => {
    expect(complete({}).window).toEqual({
      close_to_tray: true,
      tray_hint_shown: false,
      confirm_close: true,
    });
    expect(complete({ window: { close_to_tray: false } }).window).toEqual({
      close_to_tray: false,
      tray_hint_shown: false,
      confirm_close: true,
    });
  });

  it("n07_changed: merges one part; no change is the same object", () => {
    const settings = complete({});
    expect(changed(settings, "appearance", { cursor: "bar" })).toBe(settings);
    const next = changed(settings, "appearance", { cursor: "block" });
    expect(next.appearance.cursor).toBe("block");
    expect(next.terminal).toBe(settings.terminal);
    expect(stepFontSize(complete({ appearance: { font_size: 28 } }), 1).appearance.font_size).toBe(
      28,
    );
  });

  it("n07_saves_in_order: one save at a time, then only the newest", async () => {
    const started: number[] = [];
    const finish: (() => void)[] = [];
    const save = vi.fn(
      (s: { appearance?: { font_size?: number } }) =>
        new Promise<void>((done) => {
          started.push(s.appearance?.font_size ?? 0);
          finish.push(done);
        }),
    );
    const store = createSettingsStore(complete({}), save);
    store.apply((s) => changed(s, "appearance", { font_size: 15 }));
    store.apply((s) => changed(s, "appearance", { font_size: 16 }));
    store.apply((s) => changed(s, "appearance", { font_size: 17 }));
    // Nothing changes: nothing saved.
    store.apply((s) => s);
    expect(store.getState().appearance.font_size).toBe(17);
    await Promise.resolve();
    expect(started).toEqual([15]);
    finish[0]?.();
    await vi.waitFor(() => {
      expect(started).toEqual([15, 17]);
    });
    finish[1]?.();
    await store.saved();
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("n07_saves_newest: a change right as the last save ends is saved too", async () => {
    // Whichever microtask after the last save the change comes in, it is saved.
    for (let delay = 0; delay < 6; delay++) {
      const started: number[] = [];
      const finish: (() => void)[] = [];
      const save = (s: { appearance?: { font_size?: number } }) =>
        new Promise<void>((done) => {
          started.push(s.appearance?.font_size ?? 0);
          finish.push(done);
        });
      const store = createSettingsStore(complete({}), save);
      store.apply((s) => changed(s, "appearance", { font_size: 15 }));
      finish[0]?.();
      for (let i = 0; i < delay; i++) await Promise.resolve();
      store.apply((s) => changed(s, "appearance", { font_size: 16 }));
      await vi.waitFor(() => {
        expect(started).toEqual([15, 16]);
      });
      finish[1]?.();
      await store.saved();
    }
  });
});
