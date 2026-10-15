// N-01: the theme on <html> (`data-theme`), which the tokens follow: Dark Modern by default,
// Light, or Auto (the system's light or dark mode, followed live).
import type { Theme } from "@wolfcmd/bindings";

export type Look = "dark" | "light";

export function resolveTheme(theme: Theme, systemDark: boolean): Look {
  if (theme === "auto") return systemDark ? "dark" : "light";
  return theme;
}

/**
 * Keeps `root`'s `data-theme` in step with the setting (`current`, re-read on `subscribe`) and,
 * for Auto, the system. Returns the cleanup.
 */
export function installTheme(
  root: HTMLElement,
  system: MediaQueryList,
  current: () => Theme,
  subscribe: (listener: () => void) => () => void,
): () => void {
  const apply = () => {
    root.dataset.theme = resolveTheme(current(), system.matches);
  };
  apply();
  system.addEventListener("change", apply);
  const unsubscribe = subscribe(apply);
  return () => {
    system.removeEventListener("change", apply);
    unsubscribe();
  };
}
