// N-01: what the page asks the window and the system for.
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { commands } from "@wolfcmd/bindings";

import { report, unwrap } from "./ipc";

/** Shows the window once the first frame is painted. */
export function windowReady(): void {
  report(commands.appWindowReady(), "show the window");
}

/** Where a file link points: `path:line:col`, relative to the terminal's folder. */
export interface LinkPlace {
  readonly line?: number | undefined;
  readonly column?: number | undefined;
  readonly cwd?: string | undefined;
}

/**
 * N-02: a Ctrl+clicked terminal link: a URL or a file path. The core decides what opens it (a
 * browser, the editor at the line, the default app) and never runs a program.
 */
export function openLink(target: string, place: LinkPlace = {}): void {
  const link = {
    target,
    line: place.line ?? null,
    column: place.column ?? null,
    cwd: place.cwd ?? null,
  };
  report(commands.appOpenLink(link), "open the link");
}

/** The clipboard's text (right-click paste); `null` when it holds none. */
export async function clipboardText(): Promise<string | null> {
  return unwrap(await commands.appClipboardText());
}

/** The native folder picker; `null` when the user cancelled. */
export async function pickFolder(title: string, start?: string): Promise<string | null> {
  return unwrap(await commands.appPickFolder(title, start ?? null));
}

declare global {
  interface Window {
    /** Called by the core's page watchdog (`crates/wcmd-app/src/watchdog.rs`). */
    __wcPing?: () => void;
  }
}

/**
 * N-02: answers the core's page watchdog, which reloads a page that stopped answering. A
 * reload costs nothing: the terminals live in the core and the new page attaches to them.
 */
export function answerWatchdog(): void {
  window.__wcPing = () => {
    report(commands.appPong(), "answer the watchdog");
  };
}

/**
 * N-03: the window's and the web view's background follow the theme, so what a resize uncovers
 * before the page paints it again is the panel area's color (`--wc-bg-subtle`), never a light
 * frame around a dark page. The core sets the first one from the theme setting; this keeps it in
 * step when the theme changes (`<html>`'s attributes, or the system's light or dark).
 */
export function followWindowBackground(root: HTMLElement = document.documentElement): () => void {
  let applied = "";
  const apply = () => {
    const color = getComputedStyle(root).getPropertyValue("--wc-bg-subtle").trim();
    if (color === "" || color === applied) return;
    applied = color;
    getCurrentWebviewWindow()
      .setBackgroundColor(color)
      .catch((error: unknown) => {
        console.warn("could not set the window background", error);
      });
  };
  apply();
  const themes = new MutationObserver(apply);
  themes.observe(root, { attributes: true });
  const scheme = window.matchMedia("(prefers-color-scheme: dark)");
  scheme.addEventListener("change", apply);
  return () => {
    themes.disconnect();
    scheme.removeEventListener("change", apply);
  };
}
