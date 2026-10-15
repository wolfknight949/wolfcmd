// N-06: a small busy spinner: a faint ring with a bright arc turning on it, in the current text
// color. It turns at `--wc-dur-spin` per round; under reduced motion that is zero and the arc
// stands still (the ring still says "busy").
import { cn } from "./cn";

export function Spinner({
  label,
  className,
  style,
  ...data
}: {
  /** What it means, for screen readers and the tooltip ("The agent is working"). */
  readonly label: string;
  readonly className?: string;
  readonly style?: React.CSSProperties | undefined;
} & Readonly<Record<`data-${string}`, string | undefined>>) {
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox="0 0 16 16"
      className={cn("wc-spin shrink-0", className)}
      style={style}
      {...data}
    >
      <title>{label}</title>
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="2"
      />
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        // A third of the ring (2πr ≈ 37.7).
        strokeDasharray="12.6 37.7"
      />
    </svg>
  );
}
