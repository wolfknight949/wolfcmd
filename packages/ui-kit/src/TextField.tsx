// N-10: a text field with its label above and one line below it for a hint or an error.
// The line below always takes its space, so a message appearing never moves what follows.
import { type InputHTMLAttributes, type Ref, useId } from "react";

import { cn } from "./cn";

export interface TextFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "value" | "onChange"
> {
  /** The header above the box (already localized). */
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** A quiet line under the box (what will happen). */
  readonly hint?: string | undefined;
  /** A problem with the value, in the danger color instead of the hint. */
  readonly error?: string | undefined;
  readonly ref?: Ref<HTMLInputElement>;
}

export function TextField({
  label,
  value,
  onChange,
  hint,
  error,
  className,
  id,
  ...rest
}: TextFieldProps) {
  const own = useId();
  const inputId = id ?? own;
  const noteId = `${inputId}-note`;
  const note = error ?? hint;
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      <label htmlFor={inputId} className="text-md text-fg">
        {label}
      </label>
      <input
        id={inputId}
        type="text"
        value={value}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={note === undefined ? undefined : noteId}
        className="wc-input min-w-0"
        onChange={(event) => {
          onChange(event.target.value);
        }}
        {...rest}
      />
      <p
        id={noteId}
        role={error === undefined ? undefined : "alert"}
        className={cn(
          "min-h-(--wc-text-sm-leading) truncate text-sm",
          error === undefined ? "text-fg-muted" : "text-danger",
        )}
        title={note}
      >
        {note}
      </p>
    </div>
  );
}
