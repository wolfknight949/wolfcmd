// N-07: a toggle: a soft track whose round knob slides across (N-01: the accent when on). A
// `role="switch"` button: Space and Enter flip it; its name comes from `aria-labelledby` (or
// `aria-label`).
import type { ButtonHTMLAttributes, Ref } from "react";

import { cn } from "./cn";

export interface ToggleSwitchProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "type" | "role" | "onChange" | "children"
> {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly ref?: Ref<HTMLButtonElement>;
}

export function ToggleSwitch({ checked, onChange, className, ...rest }: ToggleSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={cn("wc-switch", className)}
      onClick={() => {
        onChange(!checked);
      }}
      {...rest}
    >
      <span aria-hidden className="wc-switch-track">
        <span className="wc-switch-knob" />
      </span>
    </button>
  );
}
