// N-06: the slim bar on the window's right edge. It draws the registered items (`bar.ts`), top
// to bottom (N-07: `bottom` ones at its foot); each is a `BarButton`: an icon with its name
// under it (icons only in the compact density), muted until hovered or open.
import { cn, GLYPHS } from "@wolfcmd/ui-kit";
import { type ButtonHTMLAttributes, type Ref, useSyncExternalStore } from "react";

import type { Actions } from "../actions";
import { barGroups, type BarRegistry } from "./bar";
import { keepKeyboard } from "./focus";

export function RightBar({
  bar,
  actions,
}: {
  readonly bar: BarRegistry;
  readonly actions: Actions;
}) {
  const items = useSyncExternalStore(bar.subscribe, bar.list);
  const { top, bottom } = barGroups(items);
  return (
    <nav
      aria-label="Tools"
      className="flex min-h-0 w-(--wc-widgetbar-w) shrink-0 flex-col items-center gap-1 overflow-y-auto overscroll-contain pt-0.5 pb-1.5"
    >
      {top.map(({ id, Component }) => (
        <Component key={id} actions={actions} />
      ))}
      {/* N-07: the bottom group at the bar's foot. */}
      {bottom.length > 0 && (
        <div className="mt-auto flex flex-col items-center gap-1">
          {bottom.map(({ id, Component }) => (
            <Component key={id} actions={actions} />
          ))}
        </div>
      )}
    </nav>
  );
}

export interface BarButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "type" | "title" | "children"
> {
  readonly icon: keyof typeof GLYPHS;
  /** Its name (under the icon), tooltip and accessible name. */
  readonly label: string;
  readonly ref?: Ref<HTMLButtonElement>;
}

/** A bar button. Radix triggers (`asChild`) pass their props and ref through `rest`. */
export function BarButton({ icon, label, className, ...rest }: BarButtonProps) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      // N-02: a click leaves the keyboard in the terminal (a menu's trigger passes its own).
      onMouseDown={keepKeyboard}
      {...rest}
      className={cn(
        "wc-press relative flex w-(--wc-widget-w) flex-col items-center gap-0.5 rounded-control py-1.5 text-fg-muted",
        "hover:bg-fill-hover hover:text-fg data-[state=open]:bg-fill-strong data-[state=open]:text-fg",
        className,
      )}
    >
      <span aria-hidden className="font-icons text-icon-md">
        {GLYPHS[icon]}
      </span>
      <span
        aria-hidden
        className="w-full truncate px-0.5 text-center text-xs [display:var(--wc-widget-label)]"
      >
        {label}
      </span>
    </button>
  );
}
