// No cut-off content: text that can be longer than its box ends in an ellipsis and says the
// whole thing on hover, only while it is really cut.
import { type ReactNode, useState } from "react";

import { cn } from "./cn";

/** Pure: the tooltip a truncated element needs: the full text, only while it overflows. */
function truncationTitle(
  text: string,
  box: { readonly scrollWidth: number; readonly clientWidth: number },
  title?: string,
): string | undefined {
  if (title !== undefined) return title;
  return box.scrollWidth > box.clientWidth ? text : undefined;
}

/**
 * One line that ends in "…" when it does not fit; hovering shows the full `text`. Give it
 * `min-w-0` through a flex parent (it has it), or a width; `title` replaces the tooltip
 * (e.g. a longer description).
 */
export function Truncate({
  text,
  title,
  children,
  className,
  as: Tag = "span",
}: {
  /** The full text (what the tooltip shows). Shown as the content unless `children` is given. */
  readonly text: string;
  readonly title?: string;
  readonly children?: ReactNode;
  readonly className?: string;
  readonly as?: "span" | "div" | "p";
}) {
  const [tip, setTip] = useState<string | undefined>(title);
  return (
    <Tag
      className={cn("min-w-0 truncate", className)}
      title={title ?? tip}
      onPointerEnter={(e) => {
        setTip(truncationTitle(text, e.currentTarget, title));
      }}
    >
      {children ?? text}
    </Tag>
  );
}
