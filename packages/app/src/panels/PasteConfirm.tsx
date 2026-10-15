// N-02: asks before a multi-line paste into a shell prompt, where every line could run as a
// command. Shows the first lines so the user sees what would run. Enter pastes, Esc cancels.
import { Button, useExitMotion } from "@wolfcmd/ui-kit";
import { useRef } from "react";

export interface PasteConfirmProps {
  readonly text: string;
  readonly onPaste: () => void;
  readonly onCancel: () => void;
}

/** The lines of a paste and the first few of them, for the preview. */
export function pastePreview(text: string, shown = 6): { lines: number; preview: string } {
  const lines = text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const preview = lines.slice(0, shown).join("\n") + (lines.length > shown ? "\n…" : "");
  return { lines: lines.length, preview };
}

export function PasteConfirm({ text, onPaste, onCancel }: PasteConfirmProps) {
  const { lines, preview } = pastePreview(text);
  const title = `Paste ${String(lines)} lines?`;
  // N-01: it drifts in and, answered, fades out where it was.
  const box = useRef<HTMLDivElement>(null);
  useExitMotion(box);
  return (
    <div
      ref={box}
      role="alertdialog"
      aria-label={title}
      // Never taller than the panel; the preview is the one thing that scrolls.
      className="absolute inset-x-6 top-6 z-20 flex max-h-(--wc-panel-overlay-max-h) flex-col gap-3 wc-surface-flyout p-5 wc-flyout-in"
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") onCancel();
        if (e.key === "Enter") onPaste();
      }}
    >
      <p className="shrink-0 text-heading font-medium text-fg">{title}</p>
      <p className="shrink-0 text-sm text-fg-muted">
        This is a shell prompt: each line may run as a command.
      </p>
      <pre className="max-h-40 min-h-12 overflow-auto rounded-control border border-line bg-(--wc-input-bg) p-3 font-mono text-sm whitespace-pre-wrap text-fg select-text">
        {preview}
      </pre>
      <div className="flex shrink-0 justify-end gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        <Button
          variant="accent"
          // The dialog exists because the user pasted: confirming is the expected next step.
          autoFocus
          onClick={onPaste}
        >
          Paste
        </Button>
      </div>
    </div>
  );
}
