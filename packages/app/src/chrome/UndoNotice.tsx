// N-11: the small notice after an undo or redo whose change is off screen (`undo-notice.ts`):
// floating under the title bar, so nothing below moves; it settles in and fades out.
import { useExitMotion } from "@wolfcmd/ui-kit";
import { useRef } from "react";
import { useStore } from "zustand";

import { undoNotice } from "./undo-notice";

export function UndoNotice() {
  const notice = useStore(undoNotice);
  if (notice === null) return null;
  return <Notice key={notice.id} text={notice.text} />;
}

function Notice({ text }: { readonly text: string }) {
  const box = useRef<HTMLDivElement>(null);
  useExitMotion(box);
  return (
    <div className="pointer-events-none absolute inset-x-0 top-(--wc-titlebar-h) z-30 flex justify-center pt-2">
      <div
        ref={box}
        role="status"
        className="wc-notice-in rounded-control border border-line bg-bg-elevated px-3 py-1.5 text-sm text-fg shadow-flyout"
      >
        {text}
      </div>
    </div>
  );
}
