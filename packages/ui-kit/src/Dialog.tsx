// N-10: a modal dialog (N-01: one calm surface with soft corners): a title, a body that scrolls
// alone and the buttons. It keeps the keyboard (Tab and Shift+Tab cycle inside it), Esc closes it, Enter
// submits it (it is a form: give the main button `submit`), and the focus goes back where it
// was when it closes. It sits over the window on a scrim, so nothing under it moves.
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { cn } from "./cn";
import { useExitMotion } from "./motion";
import { isTopOverlay, useOverlay } from "./overlays";

export interface DialogProps {
  /** Already localized. */
  readonly title: string;
  /** The body (fields, text). */
  readonly children: ReactNode;
  /** The buttons, the main one first (`Button` with `submit` for the one Enter presses). */
  readonly footer: ReactNode;
  /** Esc (and the caller's Cancel). */
  readonly onClose: () => void;
  /** Enter, or the `submit` button. */
  readonly onSubmit: () => void;
  /**
   * Where the focus goes when the dialog closes, when the element focused before it is gone
   * (a menu item that opened it).
   */
  readonly returnFocus?: RefObject<HTMLElement | null> | undefined;
  /** N-07: `wide` for a dialog with rows of settings (`--wc-dialog-wide-max-w`). */
  readonly size?: "standard" | "wide";
}

const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Pure: the element Tab (or Shift+Tab) moves to from `current`, wrapping around. */
function nextFocus<T>(items: readonly T[], current: T | null, back: boolean): T | undefined {
  if (items.length === 0) return undefined;
  const index = current === null ? -1 : items.indexOf(current);
  if (index < 0) return back ? items.at(-1) : items[0];
  return items[(index + (back ? -1 : 1) + items.length) % items.length];
}

export function Dialog({
  title,
  children,
  footer,
  onClose,
  onSubmit,
  returnFocus,
  size = "standard",
}: DialogProps) {
  const titleId = useId();
  const box = useRef<HTMLFormElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  // N-01: closing, its scrim fades and the dialog settles out (a copy, after React removed it).
  useExitMotion(layer, "wc-leaving-fade");
  const overlay = useOverlay("dialog");
  const latest = useRef({ onClose, returnFocus });
  useEffect(() => {
    latest.current = { onClose, returnFocus };
  });

  // N-07: what had the focus before the dialog rendered (React focuses an `autoFocus` field
  // inside it before the effect below runs).
  const [opener] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );

  // The focus moves in when it opens (to an `autoFocus` field, else the first control) and
  // goes back when it closes.
  useLayoutEffect(() => {
    const before = opener;
    const form = box.current;
    if (form !== null && !form.contains(document.activeElement)) {
      const first = form.querySelector<HTMLElement>("[autofocus]") ?? form.querySelector(FOCUSABLE);
      (first ?? form).focus();
    }
    return () => {
      const back = before?.isConnected === true ? before : latest.current.returnFocus?.current;
      back?.focus();
    };
  }, [opener]);

  // Esc closes the dialog on top, wherever the focus is (a capture listener on the window: an
  // external system).
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || !isTopOverlay(overlay.current)) return;
      event.preventDefault();
      event.stopPropagation();
      latest.current.onClose();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  }, [overlay]);

  const trap = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key !== "Tab" || event.ctrlKey || event.altKey) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      // A radio group is one stop: the checked one (or the first).
      (item) => !(item instanceof HTMLInputElement && item.type === "radio" && !radioStop(item)),
    );
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const target = nextFocus(items, active, event.shiftKey);
    event.preventDefault();
    target?.focus();
  };

  return createPortal(
    <div
      ref={layer}
      className="wc-dialog-layer wc-scrim-in fixed inset-0 z-40 flex items-start justify-center bg-scrim"
      // A click beside the dialog keeps the focus in it.
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) event.preventDefault();
      }}
    >
      <form
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        noValidate
        className={cn(
          "wc-dialog wc-dialog-surface wc-dialog-in w-full outline-none",
          size === "wide" ? "max-w-(--wc-dialog-wide-max-w)" : "max-w-(--wc-dialog-max-w)",
        )}
        onKeyDown={trap}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="wc-dialog-pinned px-(--wc-dialog-pad) pt-(--wc-dialog-pad) pb-4">
          <h2 id={titleId} className="wc-dialog-title">
            {title}
          </h2>
        </div>
        <div className="wc-dialog-body px-(--wc-dialog-pad) pb-4">{children}</div>
        <div className="wc-dialog-footer wc-dialog-pinned">{footer}</div>
      </form>
    </div>,
    document.body,
  );
}

/** Whether a radio input is its group's Tab stop: the checked one, else the group's first. */
function radioStop(radio: HTMLInputElement): boolean {
  if (radio.checked) return true;
  const group = radio.form?.querySelectorAll<HTMLInputElement>(
    `input[type="radio"][name="${CSS.escape(radio.name)}"]`,
  );
  const radios = group === undefined ? [radio] : [...group];
  return !radios.some((r) => r.checked) && radios[0] === radio;
}
