// N-03 / N-06: an empty tab: a calm card in the middle: open a terminal (Enter) or an agent.
import { Button, GLYPHS, modalOpen } from "@wolfcmd/ui-kit";
import { useEffect } from "react";

import type { Actions } from "../actions";
import { AgentChoices } from "../chrome/AgentsMenu";

export function EmptyTab({ actions }: { readonly actions: Actions }) {
  // Enter opens a terminal (a key listener on the window: an external system).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (modalOpen()) return;
      if (event.target instanceof HTMLElement && event.target.closest("button,input")) return;
      event.preventDefault();
      actions.newTerminal();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [actions]);

  return (
    <div className="absolute inset-0 flex items-center justify-center p-6">
      <div className="flex max-w-md flex-col items-center gap-5 text-center">
        <span
          aria-hidden
          className="flex size-12 items-center justify-center rounded-overlay bg-fill-quiet font-icons text-icon-xl text-fg-muted"
        >
          {GLYPHS.terminal}
        </span>
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-medium text-fg">This tab is empty</h2>
          <p className="text-md text-fg-muted">Open a terminal here, or start an agent in one.</p>
        </div>
        <Button
          variant="accent"
          icon="terminal"
          aria-label="Open a terminal (Enter)"
          onClick={() => {
            actions.newTerminal();
          }}
        >
          Open a terminal
          <kbd className="rounded-control border border-accent-fg-tint px-1.5 font-mono text-xs font-normal text-accent-fg">
            Enter
          </kbd>
        </Button>
        <AgentChoices actions={actions} />
      </div>
    </div>
  );
}
