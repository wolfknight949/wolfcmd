// N-06: what each agent panel is doing, in memory only. The core says working or idle
// (`core/activity.ts`); "finished" is the UI's: the agent went from working to idle while the
// user wasn't looking at its panel. The panel header shows working and finished; a tab pill
// shows working, and finished until the user shows that tab (`tabSeen`). A panel the user looks
// at goes straight from working to idle. Changes only on state changes, never per output chunk.
import { createStore } from "zustand/vanilla";

export interface PanelActivity {
  readonly state: "working" | "finished";
  /** Finished, and its tab was shown since: the pill's mark is gone, the header's stays. */
  readonly tabSeen: boolean;
  /**
   * N-06: finished: the agent's color (`var(--wc-workspace-<n>)`, from the catalog) and when, in
   * finish order, so the pill glows in the latest finisher's color.
   */
  readonly color?: string | undefined;
  readonly finishedAt?: number;
}

/** N-06: the order of finishes (memory only). */
let finishes = 0;

/** Panel ID → what its agent is doing (idle panels are absent). */
export const activity = createStore<Readonly<Record<string, PanelActivity>>>(() => ({}));

/** Where the user's eyes are, for one panel, when its agent stops working. */
export type Sight =
  /** The panel is focused in the shown tab, the window in front. */
  | "looking"
  /** Its tab is shown, the window in front, another panel focused. */
  | "tab"
  /** Its tab is hidden, or the window isn't in front. */
  | "away";

function without(
  all: Readonly<Record<string, PanelActivity>>,
  ids: ReadonlySet<string>,
): Readonly<Record<string, PanelActivity>> {
  return Object.fromEntries(Object.entries(all).filter(([id]) => !ids.has(id)));
}

/** The panel's agent works. */
export function agentWorking(panelId: string): void {
  if (activity.getState()[panelId]?.state === "working") return;
  activity.setState({ [panelId]: { state: "working", tabSeen: false } });
}

/**
 * The panel's agent waits again. Returns true for a finish the user didn't see (its tab
 * hidden or the window behind): the pill glows once (N-06: in `color`, the agent's), and the core
 * may tell the user.
 */
export function agentIdle(panelId: string, sight: Sight, color?: string): boolean {
  const all = activity.getState();
  if (all[panelId]?.state !== "working") return false;
  if (sight === "looking") {
    activity.setState(without(all, new Set([panelId])), true);
    return false;
  }
  finishes += 1;
  activity.setState({
    [panelId]: { state: "finished", tabSeen: sight === "tab", color, finishedAt: finishes },
  });
  return sight === "away";
}

/**
 * The user sees a tab (`tabPanels`, the window in front) and maybe looks at one of its panels:
 * the tab's finished panels lose the pill's mark, the looked-at one its header mark too.
 */
export function seen(tabPanels: readonly string[], looking: string | undefined): void {
  const all = activity.getState();
  const gone = new Set<string>();
  const marked: Record<string, PanelActivity> = {};
  for (const id of tabPanels) {
    const now = all[id];
    if (now?.state !== "finished") continue;
    if (id === looking) gone.add(id);
    else if (!now.tabSeen) marked[id] = { ...now, tabSeen: true };
  }
  if (gone.size === 0 && Object.keys(marked).length === 0) return;
  activity.setState({ ...without(all, gone), ...marked }, true);
}

/** Panels that left the document (closed, their workspace closed) are forgotten. */
export function forgetActivity(present: (panelId: string) => boolean): void {
  const all = activity.getState();
  const gone = new Set(Object.keys(all).filter((id) => !present(id)));
  if (gone.size > 0) activity.setState(without(all, gone), true);
}

/** A panel header's mark. */
export function panelMark(
  all: Readonly<Record<string, PanelActivity>>,
  panelId: string,
): PanelActivity["state"] | undefined {
  return all[panelId]?.state;
}

/** What a group of panels (a tab, a workspace) shows: an agent works there, one finished unseen. */
export interface GroupMark {
  readonly working: boolean;
  readonly done: boolean;
  /** N-06: the color of the agent that finished unseen last (when the catalog knew it)… */
  readonly color: string | undefined;
  /** …and that finish's place in the order of finishes (a new one glows the pill again). */
  readonly finishedAt: number | undefined;
}

export function groupMark(
  all: Readonly<Record<string, PanelActivity>>,
  panelIds: readonly string[],
): GroupMark {
  let working = false;
  let latest: PanelActivity | undefined;
  for (const id of panelIds) {
    const now = all[id];
    if (now?.state === "working") working = true;
    else if (
      now?.state === "finished" &&
      !now.tabSeen &&
      (now.finishedAt ?? 0) >= (latest?.finishedAt ?? 0)
    ) {
      latest = now;
    }
  }
  return {
    working,
    done: latest !== undefined,
    color: latest?.color,
    finishedAt: latest?.finishedAt,
  };
}

/** N-11: whether the panel's agent works right now (closing it asks first). */
export function working(panelId: string): boolean {
  return activity.getState()[panelId]?.state === "working";
}
