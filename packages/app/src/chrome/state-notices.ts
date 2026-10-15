// N-05: the notices about saving the workspaces, from the core's `StateHealth`. Calm: they say
// what happened and that nothing is lost, and a failing save shows until a save succeeds.
import type { StateHealth } from "@wolfcmd/bindings";

export interface StateNoticeItem {
  /** Stable while the text is the same (dismissal is kept per text). */
  readonly key: string;
  /** warning: changes aren't being saved · info: something to know, nothing to do. */
  readonly tone: "warning" | "info";
  readonly text: string;
  /** A failing save can't be hidden: it goes away by itself once a save succeeds. */
  readonly dismissible: boolean;
}

/** The notices to show now, most urgent first, without the ones the user closed. */
export function stateNotices(
  health: StateHealth,
  dismissed: ReadonlySet<string>,
): StateNoticeItem[] {
  const items: StateNoticeItem[] = [];
  if (health.saveError !== null) {
    items.push({
      key: "save",
      tone: "warning",
      text:
        "Your latest changes aren't saved yet: " +
        `${health.saveError}. WolfCmd keeps trying and keeps them until it can.`,
      dismissible: false,
    });
  }
  if (health.readOnly !== null) {
    items.push({
      key: `readOnly:${health.readOnly}`,
      tone: "warning",
      text: health.readOnly,
      dismissible: true,
    });
  }
  if (health.note !== null) {
    items.push({ key: `note:${health.note}`, tone: "info", text: health.note, dismissible: true });
  }
  return items.filter((item) => !item.dismissible || !dismissed.has(item.key));
}
