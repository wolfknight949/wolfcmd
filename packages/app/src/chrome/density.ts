// N-01: the compact density. A window narrower than `COMPACT_BELOW` CSS pixels gets slimmer
// chrome (title bar, pills, panel headers, the right bar, the gap between panels: the
// `:root[data-density="compact"]` tokens); the terminal's font size stays the user's.

/** Below this window width (CSS px) the chrome is compact. */
export const COMPACT_BELOW = 1280;

export type Density = "regular" | "compact";

export function densityFor(width: number): Density {
  return width < COMPACT_BELOW ? "compact" : "regular";
}

/** Keeps `root`'s `data-density` in step with the window's width. Returns the cleanup. */
export function installDensity(win: Window, root: HTMLElement): () => void {
  const apply = () => {
    const density = densityFor(win.innerWidth);
    if (density === "compact") root.dataset.density = density;
    else delete root.dataset.density;
  };
  apply();
  win.addEventListener("resize", apply);
  return () => {
    win.removeEventListener("resize", apply);
  };
}
