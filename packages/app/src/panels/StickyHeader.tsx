// N-02: the sticky command header: one quiet line at the top of the terminal while the user is
// scrolled inside a command's output (its exit dot, the command and its status). It follows
// scrolling, so it is painted straight into its element (`paintSticky`), never through React
// state. Never focused (the shell keeps the keyboard); a click jumps to the command's prompt.
import type { Ref } from "react";

import { commandSummary, isFailure, type MarkInfo } from "../terminal/marks";

/** Draws the header for `info` (or hides it). Writes only what changed. */
export function paintSticky(root: HTMLElement, info: MarkInfo | undefined): void {
  if (info === undefined) {
    root.hidden = true;
    return;
  }
  const command = commandSummary(info.command, 120) || "A command";
  const text = root.querySelector<HTMLElement>("[data-sticky-text]");
  const dot = root.querySelector<HTMLElement>("[data-sticky-dot]");
  const status = root.querySelector<HTMLElement>("[data-sticky-status]");
  if (text !== null && text.textContent !== command) text.textContent = command;
  if (dot !== null) dot.dataset.look = isFailure(info.exitCode) ? "failed" : info.state;
  if (status !== null) {
    status.textContent =
      info.state === "running"
        ? "running"
        : info.exitCode === undefined
          ? ""
          : `exit ${String(info.exitCode)}`;
  }
  root.title = `Go to the prompt of ${command}`;
  root.hidden = false;
}

export function StickyHeader({
  ref,
  onJump,
}: {
  readonly ref: Ref<HTMLDivElement>;
  readonly onJump: () => void;
}) {
  return (
    <div
      ref={ref}
      hidden
      aria-hidden
      onMouseDown={(e) => {
        e.preventDefault();
      }}
      onClick={onJump}
      className="absolute top-1 right-5 left-2 z-10 flex h-6 min-w-0 cursor-default items-center gap-2 rounded-control border border-line bg-bg-elevated px-2.5 text-xs text-fg shadow-flyout hover:bg-fill-hover"
    >
      <span
        data-sticky-dot=""
        className="size-1.5 shrink-0 rounded-full bg-fg-muted opacity-60 data-[look=failed]:bg-danger data-[look=failed]:opacity-90 data-[look=running]:bg-transparent data-[look=running]:ring-1 data-[look=running]:ring-fg-muted"
      />
      <span data-sticky-text="" className="min-w-0 flex-1 truncate font-mono" />
      <span data-sticky-status="" className="shrink-0 text-fg-muted tabular-nums" />
    </div>
  );
}
