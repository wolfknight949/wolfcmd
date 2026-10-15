// N-07: a segmented control (one choice among a few, side by side): a radio group of native
// radio inputs, so it is one Tab stop and the arrow keys move the choice (a `Dialog` treats it
// like any radio group). The chosen segment has the strong fill and an accent line under it.
import { useId } from "react";

export interface SegmentedOption<T extends string> {
  readonly value: T;
  /** Already localized. */
  readonly label: string;
}

export interface SegmentedProps<T extends string> {
  /** The ID of the element that names the group. */
  readonly labelledBy: string;
  readonly value: T;
  readonly options: readonly SegmentedOption<T>[];
  readonly onChange: (value: T) => void;
  /** The chosen segment takes the focus when it mounts (the first control of a dialog). */
  readonly autoFocus?: boolean;
}

export function Segmented<T extends string>({
  labelledBy,
  value,
  options,
  onChange,
  autoFocus = false,
}: SegmentedProps<T>) {
  const name = useId();
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className="wc-segmented">
      {options.map((option) => (
        <label key={option.value} className="wc-segment">
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={option.value === value}
            autoFocus={autoFocus && option.value === value}
            className="sr-only"
            onChange={() => {
              onChange(option.value);
            }}
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}
