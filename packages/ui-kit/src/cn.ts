import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/** The type and icon scales' size names (tokens.css), so they merge as font sizes and a
 *  later `text-heading` replaces `text-sm` without dropping a `text-fg-muted` color. */
const TEXT_SIZES = ["xs", "sm", "md", "base", "heading", "lg"] as const;
const ICON_SIZES = ["icon-xs", "icon-sm", "icon-md", "icon-lg", "icon-xl"] as const;

const twMerge = extendTailwindMerge({
  override: { theme: { text: [...TEXT_SIZES, ...ICON_SIZES] } },
});

/** Merges class names; later Tailwind utilities win over earlier conflicting ones. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
