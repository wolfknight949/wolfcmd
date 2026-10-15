// N-07: whether the Settings dialog is open, and the element the focus goes back to when it
// closes (the button or menu that opened it; for Ctrl+, whatever had the keyboard). The bar's
// Settings button, the workspace menu and the shortcut all open it here.
import { createStore } from "zustand/vanilla";

export interface SettingsOpen {
  readonly open: boolean;
  /** Where the focus returns when the element focused before the dialog is gone. */
  readonly returnTo: HTMLElement | null;
}

export const settingsOpen = createStore<SettingsOpen>(() => ({ open: false, returnTo: null }));

/** Opens the dialog (once; a second call while it is open changes nothing). */
export function openSettings(returnTo: HTMLElement | null = null): void {
  if (settingsOpen.getState().open) return;
  settingsOpen.setState({ open: true, returnTo });
}

export function closeSettings(): void {
  if (!settingsOpen.getState().open) return;
  settingsOpen.setState({ open: false, returnTo: null });
}
