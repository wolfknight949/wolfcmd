// N-11: "Close this panel? Claude Code is still running in it." Close (danger) and Cancel, Cancel
// focused (Enter presses the focused button, Esc cancels), and "Don't ask again", which turns
// `window.confirm_close` off (Settings › Window turns it on again).
import { Button, Dialog } from "@wolfcmd/ui-kit";
import { useId, useState } from "react";
import { useStore } from "zustand";

import { closeQuestion, type PendingClose } from "./close-question";

export function CloseDialog() {
  const pending = useStore(closeQuestion);
  if (pending === null) return null;
  // A new question starts with the box clear.
  return <Asking key={pending.question.message} pending={pending} />;
}

function Asking({ pending }: { readonly pending: PendingClose }) {
  const [dontAsk, setDontAsk] = useState(false);
  const box = useId();
  const { question, answer } = pending;
  const cancel = () => {
    answer({ close: false, dontAsk: false });
  };
  const close = () => {
    answer({ close: true, dontAsk });
  };
  return (
    <Dialog
      title={question.title}
      onClose={cancel}
      onSubmit={close}
      footer={
        <>
          <Button variant="danger" submit>
            {question.confirm}
          </Button>
          <Button autoFocus onClick={cancel}>
            Cancel
          </Button>
        </>
      }
    >
      <p className="text-sm text-fg">{question.message}</p>
      <label htmlFor={box} className="mt-4 flex items-center gap-2 text-sm text-fg-muted">
        <input
          id={box}
          type="checkbox"
          checked={dontAsk}
          onChange={(event) => {
            setDontAsk(event.currentTarget.checked);
          }}
        />
        Don&apos;t ask again
      </label>
    </Dialog>
  );
}
