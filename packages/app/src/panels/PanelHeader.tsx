// N-03: a panel's slim header, the same for every panel type: its icon and title and where it
// stands (the type's look: `HeaderLook`, from the type's `Header`; a terminal's title rule is
// `model/panel-title.ts`), then Split right and
// Split down (shown while the header is hovered or has the focus) and Close. Pressing on the
// header and dragging moves the panel (`onDragStart`, the drag engine is TabView's). N-02: a calm
// bell while its program wants the user (OSC 9 / 777, the bell, a watched command) and its
// OSC 9;4 progress as a thin bar along the bottom edge. N-03: Maximize / Restore (the button, a
// double-click on the header, Ctrl+Shift+Enter) and the header's context menu (split, maximize,
// rename in place, close).
import {
  cn,
  ContextMenu,
  GLYPHS,
  type GlyphName,
  IconButton,
  menuPoint,
  type MenuPoint,
} from "@wolfcmd/ui-kit";
import { useRef, useState } from "react";
import { useStore } from "zustand";

import { HINTS, panelMenu } from "../chrome/context-menus";
import { folderKey, folderName } from "../model/document";
import { attention, progress, type TerminalProgress } from "../store/attention";
import { AgentIcon, AgentStatus } from "./AgentActivity";
import type { PanelHeaderProps } from "./types";

/** N-03: what a panel type shows in its header. */
export interface HeaderLook {
  /** The title (also the drag label and the rename field's placeholder). */
  readonly title: string;
  readonly icon: GlyphName;
  /** The icon's and the activity dot's color (a CSS color); muted when `undefined`. */
  readonly color?: string | undefined;
  /** The folder the panel stands in (the header names it when it isn't the workspace's). */
  readonly cwd?: string | null | undefined;
}

/** What the progress bar says when hovered. */
export function progressLabel(value: TerminalProgress): string {
  switch (value.state) {
    case "indeterminate":
      return "Working…";
    case "paused":
      return `Paused at ${String(value.value)}%`;
    case "error":
      return `Failed at ${String(value.value)}%`;
    case "normal":
      return `${String(value.value)}%`;
  }
}

/** A press on one of the header's own controls (its buttons, the rename field). */
const onControl = (target: EventTarget) =>
  target instanceof Element && target.closest("button, input") !== null;

/** N-03: hands the keyboard back to the panel's terminal (after renaming in the header). */
function focusTerminal(from: Element) {
  from.closest("[data-panel]")?.querySelector<HTMLElement>(".xterm-helper-textarea")?.focus();
}

/** The panel's folder as the header shows it, when it isn't the workspace's own. */
function headerFolder(cwd: string | null | undefined, home: string | null): string | null {
  if (cwd == null || cwd === "") return null;
  if (home != null && folderKey(cwd) === folderKey(home)) return null;
  return folderName(cwd);
}

export function PanelHeader({
  panel,
  visible,
  focused,
  folder,
  alone,
  maximized,
  actions,
  onDragStart,
  look,
}: PanelHeaderProps & { readonly look: HeaderLook }) {
  const [menuAt, setMenuAt] = useState<MenuPoint | undefined>(undefined);
  const [renaming, setRenaming] = useState(false);
  /** Esc in the rename field: it closes without saving. */
  const cancelled = useRef(false);
  const wants = useStore(attention, (all) => all[panel.id]);
  const running = useStore(progress, (all) => all[panel.id]);
  const title = look.title;
  const where = headerFolder(look.cwd, folder);
  const split = (side: "right" | "down") => {
    actions.splitPanel(panel.id, side);
  };
  const maximize = () => {
    actions.toggleMaximize(panel.id);
  };
  const sections = panelMenu(
    { alone, maximized },
    {
      splitRight: () => {
        split("right");
      },
      splitDown: () => {
        split("down");
      },
      toggleMaximize: maximize,
      rename: () => {
        setRenaming(true);
      },
      close: () => {
        actions.closePanel(panel.id);
      },
    },
  );
  // Shown while the header is hovered or has the keyboard: a calm header otherwise.
  const quiet =
    "opacity-0 group-hover/header:opacity-100 group-focus-within/header:opacity-100 focus-visible:opacity-100";
  return (
    <>
      <div
        data-panel-header=""
        className={cn(
          "group/header absolute inset-x-0 top-0 flex h-(--wc-header-h) touch-none items-center gap-2 border-b border-line pr-1.5 pl-3",
          !visible && "invisible",
        )}
        onMouseDown={(event) => {
          // The header is not a focus target: a press keeps the keyboard in the panel's terminal
          // (which takes it as the panel gets the focus), during a drag and after it.
          if (!onControl(event.target)) event.preventDefault();
          actions.focusPanel(panel.id);
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || onControl(event.target)) return;
          onDragStart(panel.id, title, event);
        }}
        onDoubleClick={(event) => {
          // N-03: like a window's title bar (not on its buttons).
          if (!alone && !onControl(event.target)) maximize();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          // The rename field keeps its own right-click.
          if (!(event.target instanceof HTMLInputElement)) setMenuAt(menuPoint(event));
        }}
      >
        <AgentIcon panelId={panel.id} icon={look.icon} color={look.color} />
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          {renaming ? (
            <input
              autoFocus
              defaultValue={panel.title ?? ""}
              placeholder={title}
              aria-label="Panel name"
              className="wc-input h-(--wc-tab-h) min-w-0 flex-1 text-sm"
              onFocus={(event) => {
                event.currentTarget.select();
              }}
              onBlur={(event) => {
                if (!cancelled.current) actions.renamePanel(panel.id, event.currentTarget.value);
                cancelled.current = false;
                setRenaming(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  const field = event.currentTarget;
                  field.blur();
                  focusTerminal(field);
                }
                if (event.key === "Escape") {
                  // Nothing renamed: the field goes without its blur saving it.
                  event.preventDefault();
                  cancelled.current = true;
                  const field = event.currentTarget;
                  field.blur();
                  focusTerminal(field);
                }
              }}
            />
          ) : (
            <span
              className={cn(
                "min-w-8 shrink truncate text-sm font-medium",
                focused ? "text-fg" : "text-fg-muted",
              )}
              title={title}
            >
              {title}
            </span>
          )}
          <AgentStatus panelId={panel.id} />
          {where !== null && (
            <span className="min-w-0 truncate text-sm text-fg-muted" title={look.cwd ?? undefined}>
              {where}
            </span>
          )}
        </div>
        {wants !== undefined && (
          <span
            role="img"
            aria-label={`Wants your attention: ${wants}`}
            title={wants}
            className="shrink-0 font-icons text-icon-sm text-accent"
          >
            {GLYPHS.bell}
          </span>
        )}
        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton
            icon="splitRight"
            label={`Split right (${HINTS.splitRight})`}
            className={quiet}
            onClick={() => {
              split("right");
            }}
          />
          <IconButton
            icon="splitDown"
            label={`Split down (${HINTS.splitDown})`}
            className={quiet}
            onClick={() => {
              split("down");
            }}
          />
          {!alone && (
            <IconButton
              icon={maximized ? "unzoom" : "zoom"}
              label={maximized ? `Restore (${HINTS.maximize})` : `Maximize (${HINTS.maximize})`}
              // Restore stays in view: the panel's tiles are hidden until it is pressed.
              className={maximized ? undefined : quiet}
              onClick={maximize}
            />
          )}
          <IconButton
            icon="close"
            label={`Close (${HINTS.closePanel})`}
            onClick={() => {
              actions.closePanel(panel.id);
            }}
          />
        </div>
        {running !== undefined && (
          <div
            role="progressbar"
            aria-label={progressLabel(running)}
            aria-valuemin={0}
            aria-valuemax={100}
            {...(running.state === "indeterminate" ? {} : { "aria-valuenow": running.value })}
            title={progressLabel(running)}
            className="absolute inset-x-0 -bottom-px h-0.5 overflow-hidden"
          >
            <div
              className={cn(
                "h-full",
                running.state === "error"
                  ? "bg-danger"
                  : running.state === "paused"
                    ? "bg-warning"
                    : "bg-accent",
                running.state === "indeterminate"
                  ? "wc-indeterminate w-1/3"
                  : "w-full origin-left transition-transform duration-(--wc-dur-normal)",
              )}
              style={
                running.state === "indeterminate"
                  ? undefined
                  : { transform: `scaleX(${String(running.value / 100)})` }
              }
            />
          </div>
        )}
      </div>
      {/* Beside the header: its press handlers (drag, focus) never see the menu's clicks. */}
      <ContextMenu
        at={menuAt}
        label="Panel actions"
        sections={sections}
        onClose={() => {
          setMenuAt(undefined);
        }}
      />
    </>
  );
}
