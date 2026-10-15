// N-01: the one hint about the tray. The first time closing the window hides WolfCmd (the core's
// `window-hidden` event), a calm notice waits under the title bar for the next time the window
// shows: it is still running, and how to quit. `window.tray_hint_shown` remembers it, so it
// never shows again (not after a restart either). Memory only otherwise; closed by its button.
import { createStore } from "zustand/vanilla";

import { changed, type SettingsStore } from "../store/settings";

/** The hint's text while it shows; `null` when it doesn't. */
export const trayHint = createStore<string | null>(() => null);

/** What the hint says: `tray` when a tray icon holds WolfCmd (else the macOS Dock). */
export function trayHintText(tray: boolean): string {
  return tray
    ? "WolfCmd is still running in the tray. Quit from the tray menu or with Ctrl+Q."
    : "WolfCmd is still running. Quit with Cmd+Q.";
}

/**
 * Shows the hint the first time the window is hidden and remembers that it did; returns the
 * stop. `onHidden`: the core's event (`core/window.ts` `onWindowHidden`).
 */
export function installTrayHint(
  settings: SettingsStore,
  onHidden: (listener: (tray: boolean) => void) => () => void,
): () => void {
  return onHidden((tray) => {
    if (settings.getState().window.tray_hint_shown) return;
    trayHint.setState(trayHintText(tray), true);
    settings.apply((s) => changed(s, "window", { tray_hint_shown: true }));
  });
}

/** The user closed the hint. */
export function dismissTrayHint(): void {
  trayHint.setState(null, true);
}
