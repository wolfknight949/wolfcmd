// N-05: calm notices under the title bar when the workspaces aren't being saved (read-only
// run, a failing save) or the start had to use a backup; N-01 the one hint about the tray
// (`tray-hint.ts`). Nothing shows while all is well.
import { cn, GLYPHS, IconButton } from "@wolfcmd/ui-kit";
import { useState, useSyncExternalStore } from "react";
import { useStore } from "zustand";

import { onStateHealth, stateHealth } from "../core/state";
import { type StateNoticeItem, stateNotices } from "./state-notices";
import { dismissTrayHint, trayHint } from "./tray-hint";

/** N-01: the tray hint's key (closing it ends the hint, not a dismissal kept here). */
const TRAY = "tray";

export function StateNotice() {
  const health = useSyncExternalStore(onStateHealth, stateHealth);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const hint = useStore(trayHint);
  const notices: StateNoticeItem[] = [
    ...stateNotices(health, dismissed),
    ...(hint === null ? [] : [{ key: TRAY, tone: "info" as const, text: hint, dismissible: true }]),
  ];
  if (notices.length === 0) return null;
  return (
    <div className="flex shrink-0 flex-col gap-1 px-(--wc-panel-gap) pb-(--wc-panel-gap)">
      {notices.map((notice) => (
        <div
          key={notice.key}
          role="status"
          className={cn(
            "wc-notice-in flex min-h-8 items-center gap-2 rounded-control border px-3 py-1 text-sm text-fg",
            notice.tone === "warning"
              ? "border-warning-line bg-warning-tint"
              : "border-accent-line bg-accent-tint",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "font-icons text-icon-md",
              notice.tone === "warning" ? "text-warning" : "text-accent",
            )}
          >
            {notice.tone === "warning" ? GLYPHS.warning : GLYPHS.info}
          </span>
          <span className="min-w-0 flex-1">{notice.text}</span>
          {notice.dismissible && (
            <IconButton
              icon="close"
              label="Close"
              size="sm"
              onClick={() => {
                if (notice.key === TRAY) dismissTrayHint();
                else setDismissed((previous) => new Set(previous).add(notice.key));
              }}
            />
          )}
        </div>
      ))}
    </div>
  );
}
