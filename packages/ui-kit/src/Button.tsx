// The two buttons every surface uses, so the same action looks the same everywhere.
// `Button` has a label (optionally an icon before it);
// `IconButton` is a glyph alone, named by its tooltip. Anything that must render a button
// through another component (a Radix trigger with `asChild`, a link) uses `buttonClasses` /
// `iconButtonClasses`, never its own class list.
import type { ButtonHTMLAttributes, Ref } from "react";

import { cn } from "./cn";
import { GLYPHS, type GlyphName } from "./glyphs";

/** N-01: accent: the one main action of a surface (filled) · standard: every other action
 *  (Back, Cancel, Browse…; a quiet neutral fill) · subtle: an action inside a row, list or
 *  toolbar (a ghost) · danger: deletes or discards. */
export type ButtonVariant = "accent" | "standard" | "subtle" | "danger";
/** md: 32 px (`--wc-control-h`; dialogs, forms, empty states) · sm: 26 px
 *  (`--wc-control-h-sm`; rows, toolbars, notices, flyouts). Both 13 px text. */
export type ButtonSize = "sm" | "md";

export function buttonClasses(
  variant: ButtonVariant = "standard",
  size: ButtonSize = "md",
): string {
  return cn(
    variant === "accent"
      ? "wc-button-accent"
      : variant === "subtle"
        ? "wc-button-subtle"
        : variant === "danger"
          ? "wc-button-danger"
          : "wc-button",
    size === "sm" && "wc-button-sm",
  );
}

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /** A glyph before the label. */
  readonly icon?: GlyphName | undefined;
  /** A glyph after the label: ▷ for "run", a chevron for a menu. */
  readonly trailingIcon?: GlyphName | undefined;
  /** A toggle or a menu trigger that is on/open (`aria-pressed`, strong fill). */
  readonly pressed?: boolean | undefined;
  /** Submits its form (default: a plain button). */
  readonly submit?: boolean;
  readonly ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = "standard",
  size = "md",
  icon,
  trailingIcon,
  pressed,
  submit = false,
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={submit ? "submit" : "button"}
      aria-pressed={pressed}
      className={cn(buttonClasses(variant, size), pressed && "bg-fill-strong", className)}
      {...rest}
    >
      {icon && (
        <span
          aria-hidden
          className={cn("font-icons", size === "sm" ? "text-icon-sm" : "text-icon-md")}
        >
          {GLYPHS[icon]}
        </span>
      )}
      {children}
      {trailingIcon && (
        <span
          aria-hidden
          className={cn("font-icons", size === "sm" ? "text-icon-sm" : "text-icon-md")}
        >
          {GLYPHS[trailingIcon]}
        </span>
      )}
    </button>
  );
}

/** sm: a 20 px box with a 12 px glyph (inside a row or a 24 px strip) · md: 24 px with a 16 px
 *  glyph (panel headers, toolbars, flyouts) · lg: 32 px with a 16 px glyph (the title bar,
 *  dialog and page headers). */
export type IconButtonSize = "sm" | "md" | "lg";
export function iconButtonClasses(size: IconButtonSize = "md", pressed = false): string {
  return cn(
    "wc-press inline-flex shrink-0 items-center justify-center rounded-control font-icons",
    "hover:bg-fill-hover active:bg-fill-pressed data-[state=open]:bg-fill-strong",
    "disabled:pointer-events-none disabled:text-fg-disabled",
    size === "sm"
      ? "size-5 text-icon-sm"
      : size === "md"
        ? "size-6 text-icon-md"
        : "size-8 text-icon-md",
    // A muted line icon that turns `fg` under the pointer.
    "text-fg-muted hover:text-fg",
    pressed && "bg-fill-strong text-fg",
  );
}

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "type" | "title" | "children"
> {
  readonly icon: GlyphName;
  /** Its tooltip and accessible name (localized by the caller). `aria-label` overrides the name
   *  when the tooltip says more than the name (a second line, a shortcut). */
  readonly label: string;
  readonly size?: IconButtonSize;
  /** A toggle that is on (`aria-pressed`). Leave undefined for a plain button. */
  readonly pressed?: boolean | undefined;
  readonly ref?: Ref<HTMLButtonElement>;
}

export function IconButton({
  icon,
  label,
  size = "md",
  pressed,
  className,
  "aria-label": name,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type="button"
      title={label}
      aria-label={name ?? label}
      aria-pressed={pressed}
      className={cn(iconButtonClasses(size, pressed), className)}
      {...rest}
    >
      {GLYPHS[icon]}
    </button>
  );
}
