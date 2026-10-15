// N-06: agents in hidden workspaces: the workspace switcher's row of such a workspace says
// "Working" or "Done" (an agent finished there unseen), and the switcher button shows a small
// dot while any hidden workspace has one. Re-rendered only when those marks change.
import type { Document } from "@wolfcmd/bindings";
import { useMemo } from "react";
import { useStore } from "zustand";

import { workspacePanels } from "../model/document";
import { activity, groupMark } from "../store/activity";

export type WorkspaceMark = "Working" | "Done";

/** Each hidden workspace's mark (by workspace ID); the shown one's are on its pills. */
export function useWorkspaceMarks(doc: Document): ReadonlyMap<string, WorkspaceMark> {
  // One string ("id=Done id=Working"), so a change elsewhere doesn't re-render.
  const marks = useStore(activity, (all) =>
    doc.workspaces
      .filter((workspace) => workspace.id !== doc.active)
      .flatMap((workspace) => {
        const { working, done } = groupMark(
          all,
          workspacePanels(workspace).map((p) => p.id),
        );
        const mark = done ? "Done" : working ? "Working" : undefined;
        return mark === undefined ? [] : [`${workspace.id}=${mark}`];
      })
      .join(" "),
  );
  return useMemo(
    () =>
      new Map(
        marks
          .split(" ")
          .filter((pair) => pair !== "")
          .map((pair) => {
            const at = pair.lastIndexOf("=");
            return [pair.slice(0, at), pair.slice(at + 1) as WorkspaceMark] as const;
          }),
      ),
    [marks],
  );
}

/** The switcher button's dot: an agent works, or finished unseen, in a hidden workspace. */
export function SwitcherDot({ marks }: { readonly marks: ReadonlyMap<string, WorkspaceMark> }) {
  if (marks.size === 0) return null;
  const done = [...marks.values()].includes("Done");
  return (
    <span
      role="img"
      aria-label={
        done ? "An agent finished in another workspace" : "An agent works in another workspace"
      }
      data-activity={done ? "done" : "working"}
      className="size-1.5 shrink-0 rounded-full bg-accent"
    />
  );
}
