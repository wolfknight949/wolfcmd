// N-06: an agent panel's state in its header (`store/activity.ts`), where the eye already looks:
// the panel's icon becomes a small spinner in the agent's color while the agent works and a check
// once it finished (until the user looks at the panel), and a quiet word follows the title
// ("Working…", "Done"). Re-rendered only when this panel's state changes.
import { GLYPHS, type GlyphName, Spinner } from "@wolfcmd/ui-kit";
import { useStore } from "zustand";

import { activity, panelMark } from "../store/activity";

/** The header's icon slot: the panel's icon, or the agent's state. */
export function AgentIcon({
  panelId,
  icon,
  color,
}: {
  readonly panelId: string;
  readonly icon: GlyphName;
  /** The agent's color (a CSS color); muted when unknown. */
  readonly color: string | undefined;
}) {
  const mark = useStore(activity, (all) => panelMark(all, panelId));
  const tint = color === undefined ? undefined : { color };
  if (mark === "working") {
    return (
      <Spinner
        label="The agent is working"
        data-activity="working"
        className="size-3.5 text-fg-muted"
        style={tint}
      />
    );
  }
  if (mark === "finished") {
    return (
      <span
        role="img"
        aria-label="The agent finished"
        title="Finished"
        data-activity="finished"
        className="shrink-0 font-icons text-icon-sm text-success"
      >
        {GLYPHS.check}
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={
        color === undefined
          ? "shrink-0 font-icons text-icon-sm text-fg-muted"
          : "shrink-0 font-icons text-icon-sm"
      }
      style={tint}
    >
      {GLYPHS[icon]}
    </span>
  );
}

/** The quiet word after the title while the agent works or once it finished unseen. */
export function AgentStatus({ panelId }: { readonly panelId: string }) {
  const mark = useStore(activity, (all) => panelMark(all, panelId));
  if (mark === undefined) return null;
  return (
    <span aria-hidden className="shrink-0 text-xs text-fg-muted">
      {mark === "working" ? "Working…" : "Done"}
    </span>
  );
}
