// N-07: the user's settings, loaded at start and saved on every change. Every key has a
// default here as in the core, so the UI reads complete values.
import type {
  AgentSettings,
  AppearanceSettings,
  Settings,
  TerminalSettings,
  WindowSettings,
} from "@wolfcmd/bindings";
import { createStore, type StoreApi } from "zustand/vanilla";

export interface FullSettings {
  readonly appearance: Required<AppearanceSettings>;
  readonly terminal: Required<TerminalSettings>;
  readonly agents: Required<AgentSettings>;
  /** N-01: closing the window. */
  readonly window: Required<WindowSettings>;
}

/** The terminal font sizes the core accepts (`FONT_SIZE_MIN` / `FONT_SIZE_MAX`). */
export const FONT_SIZE = { min: 9, max: 28 } as const;

/** `settings` with every missing value at its default. */
export function complete(settings: Settings): FullSettings {
  const look = settings.appearance ?? {};
  const agents = settings.agents ?? {};
  const terminal = settings.terminal ?? {};
  const win = settings.window ?? {};
  return {
    appearance: {
      theme: look.theme ?? "dark",
      font_family: look.font_family ?? "",
      font_size: look.font_size ?? 14,
      cursor: look.cursor ?? "bar",
      smooth_scroll: look.smooth_scroll ?? true,
      finish_glow: look.finish_glow ?? true,
    },
    terminal: {
      default_profile: terminal.default_profile ?? "",
      kitty_keyboard: terminal.kitty_keyboard ?? false,
    },
    agents: {
      remote_control: agents.remote_control ?? false,
      remote_control_folders: agents.remote_control_folders ?? {},
      notify_when_done: agents.notify_when_done ?? true,
    },
    window: {
      close_to_tray: win.close_to_tray ?? true,
      tray_hint_shown: win.tray_hint_shown ?? false,
      confirm_close: win.confirm_close ?? true,
    },
  };
}

export interface SettingsStore extends StoreApi<FullSettings> {
  /** Applies a change at once and saves it (a change that changes nothing is dropped). */
  readonly apply: (change: (settings: FullSettings) => FullSettings) => void;
  /** N-07: resolves once every change applied so far is saved. */
  readonly saved: () => Promise<void>;
}

/**
 * The settings store. Saves run one at a time and only the newest waiting one runs next, so a
 * quick series of changes (a stepper held down) never lands out of order.
 */
export function createSettingsStore(
  initial: FullSettings,
  save: (settings: Settings) => Promise<unknown>,
): SettingsStore {
  const store = createStore<FullSettings>(() => initial);
  let waiting: FullSettings | undefined;
  /** The saves under way (`saved()` waits for them). */
  let saving: Promise<void> = Promise.resolve();
  let draining = false;
  const drain = async () => {
    draining = true;
    while (waiting !== undefined) {
      const next = waiting;
      waiting = undefined;
      try {
        await save({ version: 1, ...next });
      } catch (error: unknown) {
        console.warn("could not save the settings", error);
      }
    }
    // N-07: in the same step as the loop's last check, so any later change starts a new drain
    // (cleared a microtask later, a change in between waited, unsaved, for the next one).
    draining = false;
  };
  return Object.assign(store, {
    apply(change: (settings: FullSettings) => FullSettings) {
      const next = change(store.getState());
      if (next === store.getState()) return;
      store.setState(next, true);
      waiting = next;
      if (!draining) saving = drain();
    },
    saved: () => saving,
  });
}

/**
 * N-07: `settings` with `patch` merged into one of its parts; the same object when nothing
 * changes, so the store drops it.
 */
export function changed<K extends keyof FullSettings>(
  settings: FullSettings,
  part: K,
  patch: Partial<FullSettings[K]>,
): FullSettings {
  const current = settings[part];
  const same = (Object.keys(patch) as (keyof FullSettings[K])[]).every((key) =>
    Object.is(current[key], patch[key]),
  );
  return same ? settings : { ...settings, [part]: { ...current, ...patch } };
}

/** N-07: a font size brought into range (a whole number). */
export function clampFontSize(size: number): number {
  return Math.min(FONT_SIZE.max, Math.max(FONT_SIZE.min, Math.round(size)));
}

/** The terminal font one step bigger or smaller, within range. */
export function stepFontSize(settings: FullSettings, step: 1 | -1): FullSettings {
  return changed(settings, "appearance", {
    font_size: clampFontSize(settings.appearance.font_size + step),
  });
}
