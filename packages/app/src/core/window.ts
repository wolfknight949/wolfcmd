// N-01: the native window: its buttons, state, theme, the title bar's drag and system menu, and
// the maximize button's place for Snap Layouts. The rest of the UI calls these, never Tauri or
// the bindings (the layer rule, checked by ESLint).
import { getCurrentWindow } from "@tauri-apps/api/window";
import { type CaptionButtonChanged, commands, events } from "@wolfcmd/bindings";

import { report } from "./ipc";

/** Stops a listener (resolved once the listener is in place). */
export type Unlisten = Promise<() => void>;

export function minimizeWindow(): void {
  void getCurrentWindow().minimize();
}

export function toggleMaximizeWindow(): Promise<void> {
  return getCurrentWindow().toggleMaximize();
}

export function closeWindow(): void {
  void getCurrentWindow().close();
}

export function isWindowMaximized(): Promise<boolean> {
  return getCurrentWindow().isMaximized();
}

export function onWindowResized(listener: () => void): Unlisten {
  return getCurrentWindow().onResized(listener);
}

export function onWindowScaleChanged(listener: () => void): Unlisten {
  return getCurrentWindow().onScaleChanged(listener);
}

/** The title bar was pressed: the system moves the window with the pointer. */
export function startWindowDrag(): Promise<void> {
  return getCurrentWindow().startDragging();
}

/** The native window's theme (its frame and system menu); `null`: the system's. */
export function setWindowTheme(theme: "dark" | "light" | null): void {
  void getCurrentWindow().setTheme(theme);
}

/** The window's system menu at a point of the page (a right-click on the title bar). */
export async function showSystemMenu(x: number, y: number): Promise<void> {
  const result = await commands.appSystemMenu({ x, y });
  if (result.status === "error") console.warn("show the system menu failed", result.error);
}

/** Where the maximize button is, so Windows can offer Snap Layouts on it. */
export function reportMaximizeButton(rect: {
  x: number;
  y: number;
  width: number;
  height: number;
}): void {
  report(commands.appSetMaximizeButton(rect), "place the maximize button");
}

/** The maximize button's hover and press, which the native overlay above it reports. */
export function onCaptionButton(listener: (state: CaptionButtonChanged) => void): Unlisten {
  return events.captionButtonChanged.listen((event) => {
    listener(event.payload);
  });
}

/** N-01: the real quit (Ctrl+Q / Cmd+Q, like the tray's Quit): the core saves and ends everything. */
export function quitApp(): void {
  commands.appQuit().catch((error: unknown) => {
    console.warn("quit failed", error);
  });
}

/**
 * N-01: calls `listener` when closing the window hid it (`tray`: to the tray icon, else the macOS
 * Dock); returns the stop.
 */
export function onWindowHidden(listener: (tray: boolean) => void): () => void {
  const listening = events.windowHidden.listen((event) => {
    listener(event.payload.tray);
  });
  return () => {
    void listening.then((unlisten) => {
      unlisten();
    });
  };
}

/**
 * N-11: the tray's Quit while an agent runs: the window is shown and the page asks, as for
 * Ctrl+Q. Listens for the page's life.
 */
export function onQuitRequested(listener: () => void): void {
  void events.quitRequested.listen(() => {
    listener();
  });
}
