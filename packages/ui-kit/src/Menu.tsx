import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { cn } from "./cn";
import { GLYPHS, type GlyphName } from "./glyphs";
import { createFocusReturn, type FocusReturn } from "./menu-focus";
import { modalOpen, useOverlay } from "./overlays";
import { Truncate } from "./Truncate";

export interface MenuItem {
  readonly id: string;
  /** Already localized. */
  readonly label: string;
  readonly icon?: GlyphName;
  /** Right-aligned keyboard accelerator, e.g. "Ctrl+Shift+1", or a short note (N-09: an agent's plugin). */
  readonly hint?: string;
  /** A color (CSS value, usually a token) drawn as a small dot in the icon slot, e.g. a palette entry. */
  readonly swatch?: string;
  /** Selecting it. */
  readonly onSelect: () => void;
  /**
   * A toggle (`menuitemcheckbox`, a check mark while on); in a `radio` section, the
   * chosen item (a dot).
   */
  readonly checked?: boolean;
  /** Shown dimmed; the pointer and the keyboard pass over it. */
  readonly disabled?: boolean;
  /** N-10: drawn indented under the item before it (a worktree under its repository). */
  readonly inset?: boolean;
  /** N-10: the tooltip (e.g. a path), instead of the label when it is cut. */
  readonly title?: string;
  /** N-03: the item's own context menu (right-click, Shift+F10 or the Menu key on it). */
  readonly contextMenu?: ItemContextMenu;
}

/** N-03: an item's context menu: its accessible name and its sections. */
export interface ItemContextMenu {
  readonly label: string;
  readonly sections: readonly MenuSection[];
}

export interface MenuSection {
  /** Already localized; shown above the section. */
  readonly label?: string;
  readonly items: readonly MenuItem[];
  /** One choice among the items (`menuitemradio`; the `checked` one has the dot). */
  readonly radio?: boolean;
}

interface MenuProps {
  /** The button that opens the menu (rendered as is). */
  readonly trigger: ReactElement;
  /** Sections are separated by a line. */
  readonly sections: readonly MenuSection[];
  readonly align?: "start" | "end";
  /** Which side of the trigger the menu opens on (default: below). */
  readonly side?: "top" | "right" | "bottom" | "left";
  /** Controlled mode, e.g. to open the menu on right-click; omit both for a normal menu. */
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  /**
   * N-06: called once the menu is gone, while nothing else took the focus (it went back where it
   * came from, or is lost); returning true means it put the focus somewhere itself (a panel an
   * item just opened).
   */
  readonly onCloseFocus?: () => boolean;
}

/** N-03: a point in client coordinates, where a context menu opens. */
export interface MenuPoint {
  readonly x: number;
  readonly y: number;
}

/** Whether the keyboard focus is on something outside every menu (an item opened it). */
function focusMovedAway(): boolean {
  const active = document.activeElement;
  return (
    active instanceof HTMLElement &&
    active !== document.body &&
    active.closest("[role=menu]") === null
  );
}

/**
 * N-03: Radix moves the focus to an item under the pointer (or back to its menu as the pointer
 * leaves). Not while something an item opened has it (a rename field), nor from under a context
 * menu opened over this menu (a workspace row's): the pointer crossing on its way there would
 * close it.
 */
function keepFocusAway(event: PointerEvent<HTMLElement>): void {
  const context = document.activeElement?.closest("[data-wc-context-menu]");
  if (focusMovedAway() || (context != null && !context.contains(event.currentTarget))) {
    event.preventDefault();
  }
}

/** Pure: whether a menu level needs the icon column (kept only when used). */
function menuHasIcons(sections: readonly MenuSection[]): boolean {
  const needs = (item: MenuItem) =>
    item.icon !== undefined || item.checked !== undefined || item.swatch !== undefined;
  return sections.some((section) => section.radio === true || section.items.some(needs));
}

// Enter and exit motion by `data-state` / `data-side` (styles.css).
const surface = "z-50 wc-menu outline-none wc-flyout wc-no-drag";
// A long menu scrolls inside the space the window leaves, never off-screen.
const scrolls =
  "max-h-(--radix-dropdown-menu-content-available-height) overflow-y-auto overscroll-contain";

/** One `FocusReturn` per menu, made once. */
function useFocusReturn(): FocusReturn {
  const [focus] = useState(createFocusReturn);
  return focus;
}

/** Remembers what has the focus as the menu's content mounts, before the menu takes it. */
function RememberFocus({ focus }: { readonly focus: FocusReturn }) {
  useLayoutEffect(() => {
    focus.remember();
  }, [focus]);
  return null;
}

/**
 * A menu on Radix DropdownMenu (N-01: WolfCmd's own look, the same on every OS): arrows that wrap,
 * Home/End, type-ahead, Esc, Enter/Space and ARIA are built in; the look comes from the
 * `wc-menu*` classes (styles.css) over the tokens. The menu takes its accessible name from the
 * trigger, so give the trigger an `aria-label`. N-02: closing, the focus goes back to what had
 * it before the menu opened (`menu-focus.ts`: a terminal stays the keyboard's home; the trigger
 * only when the menu was opened from it or that is gone); a press on the trigger never takes it.
 */
export function Menu({
  trigger,
  sections,
  align = "start",
  side = "bottom",
  open,
  onOpenChange,
  onCloseFocus,
}: MenuProps) {
  const focus = useFocusReturn();
  const content = useRef<HTMLDivElement>(null);
  return (
    <DropdownMenu.Root
      modal={false}
      {...(open === undefined ? {} : { open })}
      onOpenChange={(next) => {
        if (!next) focus.closing(content.current);
        onOpenChange?.(next);
      }}
    >
      <DropdownMenu.Trigger
        asChild
        // N-02: a click on the trigger (closing the menu too) leaves the keyboard where it is.
        onMouseDown={(event) => {
          if (event.button === 0) event.preventDefault();
        }}
      >
        {trigger}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align={align}
          side={side}
          sideOffset={4}
          collisionPadding={8}
          loop
          ref={content}
          // Back where it came from (given back as the menu started closing), unless what an item
          // opened took it: N-10 a dialog, N-06 a new panel's terminal, or the user put it
          // elsewhere. The trigger (Radix's own) only when nothing can take it.
          onCloseAutoFocus={(event) => {
            if (
              modalOpen() ||
              !focus.untouched() ||
              onCloseFocus?.() === true ||
              focus.giveBack()
            ) {
              event.preventDefault();
            }
          }}
          className={cn("min-w-(--wc-menu-min-w)", surface, scrolls)}
        >
          <RememberFocus focus={focus} />
          <OverlayMark />
          <MenuSections sections={sections} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

interface ContextMenuProps {
  /**
   * Where it opens (client coordinates): the pointer, or the object for the keyboard. A new
   * point opens it there again; `undefined` closes it.
   */
  readonly at: MenuPoint | undefined;
  readonly sections: readonly MenuSection[];
  /** The menu's accessible name ("Tab actions"). */
  readonly label: string;
  readonly onClose: () => void;
  /** As `Menu`'s: `true` when it placed the focus itself as the menu closed. */
  readonly onCloseFocus?: () => boolean;
}

/**
 * N-03: a context menu: the same items, keys and opaque flyout as `Menu`, opened at a point (a
 * right-click, or the focused object for Shift+F10 and the Menu key) with its top left corner
 * there. When it closes, the focus goes back to where it was before it opened (the terminal,
 * the row of a menu), unless an item moved it (a rename field, a dialog).
 */
export function ContextMenu({ at, sections, label, onClose, onCloseFocus }: ContextMenuProps) {
  const [anchor, setAnchor] = useState<{ at: MenuPoint; key: number } | undefined>(undefined);
  // Each opening is a fresh menu at its own point (a second right-click moves it).
  if (at !== undefined && anchor?.at !== at) setAnchor({ at, key: (anchor?.key ?? 0) + 1 });
  if (anchor === undefined) return null;
  return (
    <ContextMenuAt
      key={anchor.key}
      at={anchor.at}
      open={at !== undefined}
      sections={sections}
      label={label}
      onClose={onClose}
      {...(onCloseFocus === undefined ? {} : { onCloseFocus })}
    />
  );
}

function ContextMenuAt({
  at,
  open,
  sections,
  label,
  onClose,
  onCloseFocus,
}: Omit<ContextMenuProps, "at"> & { readonly at: MenuPoint; readonly open: boolean }) {
  const focus = useFocusReturn();
  const content = useRef<HTMLDivElement>(null);
  return (
    <DropdownMenu.Root
      modal={false}
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        focus.closing(content.current);
        onClose();
      }}
    >
      {/* The invisible anchor at the point, outside every transformed parent. */}
      {createPortal(
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            tabIndex={-1}
            aria-label={label}
            className="pointer-events-none fixed size-px opacity-0"
            style={{ left: at.x, top: at.y }}
          />
        </DropdownMenu.Trigger>,
        document.body,
      )}
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          side="bottom"
          sideOffset={0}
          collisionPadding={8}
          loop
          ref={content}
          data-wc-context-menu=""
          onCloseAutoFocus={(event) => {
            // Never to the anchor: back where it was (given back as it started closing), unless
            // something else has it now.
            event.preventDefault();
            if (modalOpen() || !focus.untouched()) return;
            if (onCloseFocus?.() === true) return;
            focus.giveBack();
          }}
          className={cn("min-w-(--wc-menu-min-w)", surface, scrolls)}
        >
          <RememberFocus focus={focus} />
          <OverlayMark />
          <MenuSections sections={sections} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** The point a right-click (or the keyboard's menu event) opens a context menu at. */
export function menuPoint(event: MouseEvent | globalThis.MouseEvent): MenuPoint {
  return { x: event.clientX, y: event.clientY };
}

/**
 * The menu is in the overlay registry while its content is mounted (open, and
 * during its exit animation), so browser pages hide and a flyout under it leaves Esc to it.
 */
function OverlayMark() {
  useOverlay("menu");
  return null;
}

function MenuSections({ sections }: { readonly sections: readonly MenuSection[] }) {
  const icons = menuHasIcons(sections);
  return (
    <>
      {sections.map((section, index) => (
        <DropdownMenu.Group key={section.label ?? String(index)}>
          {index > 0 && <DropdownMenu.Separator className="wc-menu-separator" />}
          {section.label && (
            <DropdownMenu.Label className="wc-menu-label">{section.label}</DropdownMenu.Label>
          )}
          {section.radio ? (
            <DropdownMenu.RadioGroup
              value={section.items.find((item) => item.checked === true)?.id ?? ""}
            >
              {section.items.map((item) => (
                <MenuEntry key={item.id} item={item} icons={icons} mark="radio" />
              ))}
            </DropdownMenu.RadioGroup>
          ) : (
            section.items.map((item) => (
              <MenuEntry
                key={item.id}
                item={item}
                icons={icons}
                mark={item.checked === undefined ? undefined : "check"}
              />
            ))
          )}
        </DropdownMenu.Group>
      ))}
    </>
  );
}

/** An item's row: indented when `inset`. */
function itemClass(item: MenuItem): string {
  return cn("wc-menu-item", item.inset === true && "wc-menu-item-inset");
}

type Mark = "check" | "radio";

/** The icon column: the check or radio mark while chosen, else the item's icon. */
function leading(item: MenuItem, mark: Mark | undefined): ReactNode {
  if (mark !== undefined && item.checked === true) {
    return mark === "radio" ? <span className="wc-menu-radio" /> : GLYPHS.check;
  }
  return item.icon ? GLYPHS[item.icon] : "";
}

function ItemContent({
  item,
  icons,
  mark,
}: {
  readonly item: MenuItem;
  readonly icons: boolean;
  readonly mark: Mark | undefined;
}) {
  return (
    <>
      {icons && (
        <span aria-hidden className="wc-menu-icon">
          {item.swatch === undefined ? (
            leading(item, mark)
          ) : (
            // A workspace color is a dot in the icon column.
            <span
              className="inline-block size-2.5 rounded-full align-middle"
              style={{ backgroundColor: item.swatch }}
            />
          )}
        </span>
      )}
      <Truncate
        text={item.label}
        className="flex-1"
        {...(item.title === undefined ? {} : { title: item.title })}
      />
      {item.hint && <span className="wc-menu-hint shrink-0 whitespace-nowrap">{item.hint}</span>}
    </>
  );
}

/**
 * One item: plain, a toggle (`checked`) or a radio choice.
 */
function MenuEntry({
  item,
  icons,
  mark,
}: {
  readonly item: MenuItem;
  readonly icons: boolean;
  readonly mark: Mark | undefined;
}) {
  const disabled = item.disabled === true;
  const [menuAt, setMenuAt] = useState<MenuPoint | undefined>(undefined);
  const own = item.contextMenu;
  // N-03: the item's own context menu, beside it in the React tree (inside this menu, so this
  // menu stays open while it is used; never inside the item, whose keys and clicks it would get).
  const withMenu = (element: ReactElement) =>
    own === undefined ? (
      element
    ) : (
      <>
        {element}
        <ContextMenu
          at={menuAt}
          label={own.label}
          sections={own.sections}
          onClose={() => {
            setMenuAt(undefined);
          }}
        />
      </>
    );
  const menuProps = {
    // N-03: once an item gave the focus to what it opened (a rename field), the pointer leaving
    // or crossing this menu as it fades out must not take it back.
    onPointerLeave: keepFocusAway,
    onPointerMove: keepFocusAway,
    ...(own === undefined
      ? {}
      : {
          onContextMenu: (event: MouseEvent) => {
            event.preventDefault();
            setMenuAt(menuPoint(event));
          },
        }),
  };
  const content = <ItemContent item={item} icons={icons} mark={mark} />;
  if (mark === "radio") {
    return withMenu(
      <DropdownMenu.RadioItem
        value={item.id}
        textValue={item.label}
        disabled={disabled}
        onSelect={item.onSelect}
        className={itemClass(item)}
        {...menuProps}
      >
        {content}
      </DropdownMenu.RadioItem>,
    );
  }
  if (mark === "check") {
    return withMenu(
      <DropdownMenu.CheckboxItem
        checked={item.checked === true}
        textValue={item.label}
        disabled={disabled}
        onSelect={item.onSelect}
        className={itemClass(item)}
        {...menuProps}
      >
        {content}
      </DropdownMenu.CheckboxItem>,
    );
  }
  return withMenu(
    <DropdownMenu.Item
      disabled={disabled}
      textValue={item.label}
      onSelect={item.onSelect}
      className={itemClass(item)}
      {...menuProps}
    >
      {content}
    </DropdownMenu.Item>,
  );
}
