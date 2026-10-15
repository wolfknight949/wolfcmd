// N-05 / N-07: loading and saving the workspace document and the settings.
import {
  commands,
  type Document,
  events,
  type LoadedState,
  type Settings,
  type StateHealth,
} from "@wolfcmd/bindings";

import { report, unwrap } from "./ipc";

// N-05: what the core says about saving (read-only and why, a save failing, a note from the
// start). Set by `loadState`, then by the core's `state-health` event.
let health: StateHealth = { readOnly: null, saveError: null, note: null };
const healthListeners = new Set<() => void>();
let listening = false;

function setHealth(next: StateHealth): void {
  health = next;
  for (const listener of healthListeners) listener();
}

export async function loadState(): Promise<LoadedState> {
  if (!listening) {
    listening = true;
    void events.stateHealth.listen((event) => {
      setHealth(event.payload);
    });
  }
  const loaded = unwrap(await commands.stateLoad());
  setHealth(loaded.health);
  return loaded;
}

/** N-05: the latest saving health (for `useSyncExternalStore`). */
export function stateHealth(): StateHealth {
  return health;
}

/** N-05: calls `listener` whenever the saving health changes; returns the unsubscribe. */
export function onStateHealth(listener: () => void): () => void {
  healthListeners.add(listener);
  return () => {
    healthListeners.delete(listener);
  };
}

/** This page's saves, numbered from 1: the core drops an older document that comes late. */
let saves = 0;

/** Every change: the core saves it at once, crash-safe (the newest wins). */
export function saveState(document: Document): void {
  saves += 1;
  report(commands.stateSave(saves, document), "save workspaces");
}

export async function loadSettings(): Promise<Settings> {
  return unwrap(await commands.settingsLoad());
}

export async function saveSettings(settings: Settings): Promise<Settings> {
  return unwrap(await commands.settingsSave(settings));
}
