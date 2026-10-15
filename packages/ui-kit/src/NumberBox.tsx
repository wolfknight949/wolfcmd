// N-07: a number box with its step buttons: a whole number within `min`…`max`. Typing
// commits on Enter or when the box loses the focus (a wrong value goes back); the arrow keys,
// Page Up / Page Down and the buttons step at once.
import { type KeyboardEvent, useState } from "react";

import { IconButton } from "./Button";

export interface NumberBoxProps {
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly onChange: (value: number) => void;
  /** The ID of the element that names it. */
  readonly labelledBy: string;
  /** The spin buttons' names (already localized). */
  readonly stepNames?: { readonly up: string; readonly down: string };
}

/** Pure: the typed text as a value in range, or `undefined` when it isn't a number. */
export function parseNumber(text: string, min: number, max: number): number | undefined {
  const trimmed = text.trim();
  if (!/^[+-]?\d+(\.\d+)?$/.test(trimmed)) return undefined;
  return Math.min(max, Math.max(min, Math.round(Number(trimmed))));
}

export function NumberBox({
  value,
  min,
  max,
  onChange,
  labelledBy,
  stepNames = { up: "Increase", down: "Decrease" },
}: NumberBoxProps) {
  // What the user is typing; otherwise the value (a change from elsewhere shows at once).
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const text = draft ?? String(value);

  const set = (next: number) => {
    const clamped = Math.min(max, Math.max(min, next));
    setDraft(undefined);
    if (clamped !== value) onChange(clamped);
  };
  const commit = () => {
    if (draft === undefined) return;
    const parsed = parseNumber(draft, min, max);
    if (parsed === undefined) setDraft(undefined);
    else set(parsed);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const steps: Partial<Record<string, number>> = {
      ArrowUp: 1,
      ArrowDown: -1,
      PageUp: 10,
      PageDown: -10,
    };
    const step = steps[event.key];
    if (step !== undefined) {
      event.preventDefault();
      set((parseNumber(text, min, max) ?? value) + step);
    } else if (event.key === "Enter") {
      // Commits here; the form (a dialog) doesn't submit.
      event.preventDefault();
      commit();
    }
  };

  return (
    <div className="flex items-center gap-1">
      <input
        type="text"
        inputMode="numeric"
        role="spinbutton"
        aria-labelledby={labelledBy}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        spellCheck={false}
        autoComplete="off"
        value={text}
        className="wc-input w-(--wc-numberbox-w) text-center"
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />
      <IconButton
        icon="chevronDown"
        label={stepNames.down}
        disabled={value <= min}
        onClick={() => {
          set(value - 1);
        }}
      />
      <IconButton
        icon="chevronUp"
        label={stepNames.up}
        disabled={value >= max}
        onClick={() => {
          set(value + 1);
        }}
      />
    </div>
  );
}
