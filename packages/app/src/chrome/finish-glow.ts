// N-06: the finish reward's rules. When an agent finishes and the user isn't looking at its panel,
// that panel's own block glows once, in the agent's color (`panels/PanelGlow.tsx`). On screen
// (its tab shown, not parked behind a maximized panel, the window in front) but not the focused
// panel, it plays at once; otherwise it waits and plays when the panel comes on screen (its tab
// or workspace shown, the maximize ended, the window back in front). Never for the panel the user
// looks at; a finish never glows twice; each panel glows on its own. Nothing with the setting off
// (`appearance.finish_glow`) or under reduced motion. Memory only, no timers: plain events.
import { createStore } from "zustand/vanilla";

import type { Sight } from "../store/activity";

/** A panel's glow to play: waiting until its panel is on screen, then ready for its card. */
export interface PendingGlow {
  /** The agent's color (a CSS color), if known. */
  readonly color: string | undefined;
  /** Its panel is on screen: the card plays it now and clears it (`glowPlayed`). */
  readonly ready: boolean;
}

/** Panel ID → its glow to play (panels with none are absent). Memory only. */
export const pendingGlows = createStore<Readonly<Record<string, PendingGlow>>>(() => ({}));

function without(id: string): void {
  const all = pendingGlows.getState();
  if (!(id in all)) return;
  pendingGlows.setState(
    Object.fromEntries(Object.entries(all).filter(([other]) => other !== id)),
    true,
  );
}

/** The card played its panel's glow: it never plays again for that finish. */
export function glowPlayed(panelId: string): void {
  without(panelId);
}

export interface FinishGlowDeps {
  /** The glow may play: the setting is on and the system doesn't reduce motion. */
  readonly allowed: () => boolean;
}

export interface FinishGlow {
  /** The panel's agent finished, the user's eyes `sight` (its color, if known). */
  readonly finished: (panelId: string, color: string | undefined, sight: Sight) => void;
  /** Where the user looks may have changed: waiting glows whose panel is on screen now play. */
  readonly look: (sightOf: (panelId: string) => Sight) => void;
  /** Panels that left the document lose their glow. */
  readonly forget: (present: (panelId: string) => boolean) => void;
}

export function createFinishGlow(deps: FinishGlowDeps): FinishGlow {
  return {
    finished: (panelId, color, sight) => {
      if (sight === "looking" || !deps.allowed()) {
        without(panelId);
        return;
      }
      pendingGlows.setState({ [panelId]: { color, ready: sight === "tab" } });
    },
    look: (sightOf) => {
      const all = pendingGlows.getState();
      const waiting = Object.entries(all).filter(([, glow]) => !glow.ready);
      if (waiting.length === 0) return;
      // The setting turned off or reduced motion since: the waiting ones go.
      if (!deps.allowed()) {
        pendingGlows.setState(
          Object.fromEntries(Object.entries(all).filter(([, glow]) => glow.ready)),
          true,
        );
        return;
      }
      const shown = waiting.filter(([id]) => sightOf(id) !== "away");
      if (shown.length === 0) return;
      pendingGlows.setState(
        Object.fromEntries(shown.map(([id, glow]) => [id, { ...glow, ready: true }])),
      );
    },
    forget: (present) => {
      const all = pendingGlows.getState();
      const ids = Object.keys(all);
      if (ids.every(present)) return;
      pendingGlows.setState(
        Object.fromEntries(Object.entries(all).filter(([id]) => present(id))),
        true,
      );
    },
  };
}
