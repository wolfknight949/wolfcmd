// N-02 / N-06: when a freshly started shell is ready for input (its first prompt), so an agent
// panel can type its agent's start or resume line. Never for a shell the view attached to: it
// is already running (an agent may be at work in it), so nothing is ever typed into it.

/** After the first prompt, wait this long before the shell counts as ready. */
export const READY_SETTLE_MS = 250;
/**
 * N-06: a shell without integration (no prompt marks) counts as ready this long after it
 * started. A shell with integration waits for its prompt however long its profile takes: a
 * line typed before the prompt could be lost or run by the profile.
 */
export const READY_FALLBACK_MS = 5000;

export interface Readiness {
  /** The shell printed a prompt (OSC 133;B). May come before `started`. */
  prompt(): void;
  /**
   * The session is open: `attached` when it was already running; `integrated` when the shell
   * marks its prompts (shell integration), so no guess is needed.
   */
  started(attached: boolean, integrated: boolean): void;
  dispose(): void;
}

/** Calls `onReady` at most once, and only for a shell started by this view. */
export function createReadiness(onReady: () => void): Readiness {
  let state: "opening" | "fresh" | "done" = "opening";
  let prompted = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const clear = () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
  const fire = () => {
    if (state !== "fresh") return;
    state = "done";
    clear();
    onReady();
  };
  const later = (ms: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fire();
    }, ms);
    timers.add(timer);
  };
  return {
    prompt() {
      prompted = true;
      if (state === "fresh") later(READY_SETTLE_MS);
    },
    started(attached, integrated) {
      if (state !== "opening") return;
      if (attached) {
        state = "done";
        return;
      }
      state = "fresh";
      if (prompted) later(READY_SETTLE_MS);
      else if (!integrated) later(READY_FALLBACK_MS);
    },
    dispose() {
      state = "done";
      clear();
    },
  };
}
