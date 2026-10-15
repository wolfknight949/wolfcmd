// N-03: the shown workspace's tabs as pills: click shows one, double-click renames it, middle-click
// or × closes it, + adds one, and a pill dragged sideways reorders the tabs (it lifts and follows
// the pointer, the others make room; Esc puts it back). Ctrl+Tab and Ctrl+Alt+1…9 switch from
// the keyboard. Fixed-width pills with the name centred; a thin line between two pills that
// aren't shown. N-02: a calm dot on a tab whose panel wants the user (its program asked for
// attention). N-03: a pill's context menu (rename, new, duplicate, close, close others, close to
// the right) and a quiet mark while one of its panels is maximized. N-01: a new pill settles in, a
// closed one fades out where it was while the others glide into place (Web Animations on the DOM,
// no React state).
import type { Workspace } from "@wolfcmd/bindings";
import {
  cn,
  ContextMenu,
  durationToken,
  easingToken,
  GLYPHS,
  IconButton,
  leaveGhost,
  menuPoint,
  numberToken,
  type MenuPoint,
} from "@wolfcmd/ui-kit";
import { type PointerEvent, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "zustand";

import type { Actions } from "../actions";
import { maximizedPanel, tabName } from "../model/document";
import { clampTabOffset, pastThreshold, tabIndexAt, tabShifts } from "../model/drop";
import { panelsOf } from "../model/layout";
import { attention, wantsAttention } from "../store/attention";
import { HINTS, tabMenu } from "./context-menus";
import { keepKeyboard } from "./focus";
import { PillActivity } from "./PillActivity";

/** Set on a pill's wrapper while it is dragged: it lifts above the others. */
const LIFTED = "data-lifted";
/** A pill's wrapper carries its tab's ID (the drag and the settle motion find pills by it). */
const TAB_ID = "data-tab-id";

/** A motion token's duration in ms (0 under reduced motion). */
const duration = (name: string) => durationToken(name.replace(/^--wc-/, ""));

/** N-01: a pill as last laid out: its wrapper and where it stood in the strip. */
interface LaidOut {
  readonly element: HTMLElement;
  readonly left: number;
  readonly width: number;
}

export function TabPills({
  workspace,
  actions,
}: {
  readonly workspace: Workspace;
  readonly actions: Actions;
}) {
  const [renaming, setRenaming] = useState<string | undefined>(undefined);
  // N-03: the pill whose menu is open (kept while it fades out, without `at`).
  const [menu, setMenu] = useState<{ readonly tabId: string; readonly at?: MenuPoint }>();
  // The tabs that want the user, as one string (a stable snapshot for the store).
  const calling = useStore(attention, (all) =>
    workspace.tabs
      .filter(
        (tab) =>
          tab.layout != null &&
          wantsAttention(
            all,
            panelsOf(tab.layout).map((p) => p.id),
          ),
      )
      .map((tab) => tab.id)
      .join(" "),
  );
  const strip = useRef<HTMLDivElement>(null);
  /** Where the pills were seen when a drag ended (by tab ID), until they settle in place. */
  const settling = useRef<Map<string, number>>(undefined);
  /** N-01: the shown workspace's pills as last laid out (by tab ID). */
  const laidOut = useRef<{ readonly workspace: string; readonly pills: Map<string, LaidOut> }>(
    undefined,
  );
  const shownIndex = workspace.tabs.findIndex((t) => t.id === workspace.activeTab);
  const menuIndex = workspace.tabs.findIndex((t) => t.id === menu?.tabId);
  const menuTab = workspace.tabs[menuIndex];
  const menuSections =
    menuTab === undefined
      ? []
      : tabMenu(menuIndex, workspace.tabs.length, {
          rename: () => {
            setRenaming(menuTab.id);
          },
          newTab: () => {
            actions.newTab();
          },
          duplicate: () => {
            actions.duplicateTab(menuTab.id);
          },
          close: () => {
            actions.closeTab(menuTab.id);
          },
          closeOthers: () => {
            actions.closeOtherTabs(menuTab.id);
          },
          closeToRight: () => {
            actions.closeTabsToRight(menuTab.id);
          },
        });

  // N-01: a tab added or closed: the new pill settles in, the closed one fades out where it was,
  // the others glide from their old places (measured after each render; a drag's drop settles
  // below instead).
  useLayoutEffect(() => {
    const list = strip.current;
    if (list === null) return;
    const before = laidOut.current;
    const now = new Map(
      pills(list).map((pill) => [
        pill.getAttribute(TAB_ID) ?? "",
        { element: pill, left: pill.offsetLeft, width: pill.offsetWidth },
      ]),
    );
    laidOut.current = { workspace: workspace.id, pills: now };
    if (before?.workspace !== workspace.id || settling.current !== undefined) return;
    const gone = [...before.pills].filter(([id]) => !now.has(id));
    const added = [...now.keys()].filter((id) => !before.pills.has(id));
    const ms = duration("dur-normal");
    if ((gone.length === 0 && added.length === 0) || ms <= 0) return;
    if (typeof list.animate !== "function") return;
    const easing = easingToken("ease-out");
    const enter = `scale(${String(numberToken("enter-scale", 1))})`;
    for (const [id, { element, left }] of now) {
      const was = before.pills.get(id);
      if (was === undefined) {
        element.animate(
          [
            { opacity: 0, transform: enter },
            { opacity: 1, transform: "none" },
          ],
          { duration: ms, easing },
        );
        continue;
      }
      const dx = was.left - left;
      if (Math.abs(dx) >= 0.5) {
        element.animate([{ transform: `translateX(${String(dx)}px)` }, { transform: "none" }], {
          duration: ms,
          easing,
        });
      }
    }
    for (const [, { element, left, width }] of gone) {
      leaveGhost(element, {
        parent: list,
        style: {
          position: "absolute",
          top: "0",
          left: `${String(left)}px`,
          width: `${String(width)}px`,
        },
      });
    }
  });

  // After a drop, each pill glides from where it was seen to its new place (DOM measurements:
  // the layout itself is React's).
  useLayoutEffect(() => {
    const seen = settling.current;
    if (seen === undefined) return;
    settling.current = undefined;
    const ms = duration("dur-normal");
    for (const pill of pills(strip.current)) {
      pill.style.transform = "";
      pill.style.transition = "";
      pill.style.zIndex = "";
      const from = seen.get(pill.getAttribute(TAB_ID) ?? "");
      const dx = from === undefined ? 0 : from - pill.offsetLeft;
      if (ms > 0 && Math.abs(dx) >= 0.5 && typeof pill.animate === "function") {
        pill.animate([{ transform: `translateX(${String(dx)}px)` }, { transform: "none" }], {
          duration: ms,
          easing: "cubic-bezier(0, 0, 0, 1)",
        });
      }
    }
  });

  /** N-03: a press on a pill that may become a drag to reorder (pointer events, no ghost image). */
  const startDrag = (tabId: string, event: PointerEvent<HTMLDivElement>) => {
    const list = strip.current;
    if (event.button !== 0 || list === null) return;
    if (event.target instanceof Element && event.target.closest("button, input")) return;
    const pill = event.currentTarget;
    const all = pills(list);
    const from = all.indexOf(pill);
    if (from < 0) return;
    const centers = all
      .filter((other) => other !== pill)
      .map((other) => {
        const r = other.getBoundingClientRect();
        return r.left + r.width / 2;
      });
    const box = pill.getBoundingClientRect();
    const area = list.getBoundingClientRect();
    const startX = event.clientX;
    const pointerId = event.pointerId;
    // N-03: the tab keeps the pointer from the press on, so a release anywhere ends the press
    // (its click and double-click still reach it).
    const pressed =
      event.target instanceof Element ? event.target.closest<HTMLElement>('[role="tab"]') : null;
    const grip = pressed !== null && pill.contains(pressed) ? pressed : pill;
    let dragging = false;
    let index = from;
    let dx = 0;
    let shifts = all.map(() => 0);
    let frame = 0;
    const paint = () => {
      frame = 0;
      pill.style.transform = `translateX(${String(dx)}px)`;
      const next = tabShifts(all.length, from, index, box.width);
      all.forEach((other, i) => {
        if (other === pill || next[i] === shifts[i]) return;
        other.style.transition = "transform var(--wc-dur-normal) var(--wc-ease-out)";
        other.style.transform = next[i] ? `translateX(${String(next[i])}px)` : "";
      });
      shifts = next;
    };
    const reset = () => {
      for (const other of all) {
        other.style.transform = "";
        other.style.transition = "";
        other.style.zIndex = "";
      }
    };
    const finish = (drop: boolean) => {
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onUp);
      grip.removeEventListener("pointercancel", onCancel);
      grip.removeEventListener("lostpointercapture", onCancel);
      window.removeEventListener("keydown", onKey, { capture: true });
      if (grip.hasPointerCapture(pointerId)) grip.releasePointerCapture(pointerId);
      cancelAnimationFrame(frame);
      frame = 0;
      pill.removeAttribute(LIFTED);
      if (!dragging) return;
      if (!drop || index === from) {
        // Back to its place, gliding (the others slide back too).
        for (const other of all) {
          other.style.transition = "transform var(--wc-dur-normal) var(--wc-ease-out)";
          other.style.transform = "";
        }
        window.setTimeout(reset, duration("dur-normal"));
        return;
      }
      settling.current = new Map(
        all.map((other, i) => [
          other.getAttribute(TAB_ID) ?? "",
          other.offsetLeft + (other === pill ? dx : (shifts[i] ?? 0)),
        ]),
      );
      reset();
      actions.moveTab(tabId, index);
    };
    const onMove = (moved: globalThis.PointerEvent) => {
      if (!dragging) {
        if (!pastThreshold(moved.clientX - startX, 0)) return;
        dragging = true;
        pill.setAttribute(LIFTED, "");
        pill.style.zIndex = "10";
      }
      dx = clampTabOffset(
        moved.clientX - startX,
        { left: box.left, width: box.width },
        { left: area.left, width: area.width },
      );
      index = tabIndexAt(box.left + box.width / 2 + dx, centers);
      frame ||= requestAnimationFrame(paint);
    };
    const onUp = () => {
      finish(true);
    };
    const onCancel = () => {
      finish(false);
    };
    const onKey = (key: KeyboardEvent) => {
      if (key.key !== "Escape" || !dragging) return;
      key.preventDefault();
      key.stopPropagation();
      finish(false);
    };
    grip.setPointerCapture(pointerId);
    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
    grip.addEventListener("pointercancel", onCancel);
    grip.addEventListener("lostpointercapture", onCancel);
    window.addEventListener("keydown", onKey, { capture: true });
  };

  return (
    <div
      ref={strip}
      role="tablist"
      aria-label="Tabs"
      className="wc-no-drag relative flex h-full min-w-0 items-center"
    >
      {workspace.tabs.map((tab, index) => {
        const shown = tab.id === workspace.activeTab;
        const name = tabName(workspace, tab);
        // The line between pills hides next to the shown one (and before the first).
        const divider = index > 0 && index !== shownIndex && index - 1 !== shownIndex;
        if (renaming === tab.id) {
          return (
            <input
              key={tab.id}
              autoFocus
              defaultValue={tab.name ?? ""}
              placeholder={name}
              aria-label="Tab name"
              className="wc-input mx-0.5 h-(--wc-tab-h) w-(--wc-tab-w) text-center text-sm"
              onFocus={(event) => {
                event.currentTarget.select();
              }}
              onBlur={(event) => {
                actions.renameTab(tab.id, event.currentTarget.value);
                setRenaming(undefined);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") setRenaming(undefined);
              }}
            />
          );
        }
        return (
          <div
            key={tab.id}
            {...{ [TAB_ID]: tab.id }}
            className="group/tab relative flex h-full min-w-0 shrink items-center"
            onPointerDown={(event) => {
              startDrag(tab.id, event);
            }}
          >
            <span
              aria-hidden
              className={cn(
                "h-3.5 w-px shrink-0 bg-fill-strong group-data-[lifted]/tab:invisible",
                !divider && "invisible",
              )}
            />
            <div
              role="tab"
              aria-selected={shown}
              tabIndex={-1}
              title={index < 9 ? `${name} (Ctrl+Alt+${String(index + 1)})` : name}
              className={cn(
                "group relative mx-0.5 flex h-(--wc-tab-h) w-(--wc-tab-w) min-w-(--wc-tab-min-w) shrink items-center justify-center rounded-control px-6 text-sm",
                "transition-[background-color,color,scale,box-shadow] duration-(--wc-dur-fast) ease-out",
                shown
                  ? "bg-fill-strong font-medium text-fg"
                  : "text-fg-muted hover:bg-fill-hover hover:text-fg active:bg-fill-pressed",
                // Lifted while dragged.
                "group-data-[lifted]/tab:scale-(--wc-lift-scale) group-data-[lifted]/tab:bg-bg-elevated",
                "group-data-[lifted]/tab:text-fg group-data-[lifted]/tab:shadow-flyout",
              )}
              onMouseDown={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  actions.closeTab(tab.id);
                  return;
                }
                // N-03: a right-click leaves the keyboard where it is (its menu gives it back);
                // N-02: so does a left one: the tab's terminal takes it, never the pill.
                if (event.button === 2) event.preventDefault();
                if (event.button === 0) {
                  keepKeyboard(event);
                  actions.activateTab(tab.id);
                }
              }}
              onDoubleClick={() => {
                setRenaming(tab.id);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ tabId: tab.id, at: menuPoint(event) });
              }}
            >
              <span className="min-w-0 truncate">{name}</span>
              {maximizedPanel(tab) !== undefined && (
                // N-03: a panel fills this tab (its others are hidden).
                <span
                  role="img"
                  aria-label="A panel is maximized"
                  title={`A panel is maximized (${HINTS.maximize} restores)`}
                  className="ml-1.5 shrink-0 font-icons text-icon-xs text-fg-muted"
                >
                  {GLYPHS.zoom}
                </span>
              )}
              {calling.split(" ").includes(tab.id) && (
                <span
                  role="img"
                  aria-label="A panel here wants your attention"
                  className="ml-1.5 size-1.5 shrink-0 rounded-full bg-accent"
                />
              )}
              <PillActivity tab={tab} />
              <IconButton
                icon="close"
                label="Close tab"
                size="sm"
                className="absolute right-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                onMouseDown={(event) => {
                  event.stopPropagation();
                  keepKeyboard(event);
                }}
                onClick={() => {
                  actions.closeTab(tab.id);
                }}
              />
            </div>
          </div>
        );
      })}
      <ContextMenu
        at={menu?.at}
        label="Tab actions"
        sections={menuSections}
        onClose={() => {
          setMenu((now) => (now === undefined ? now : { tabId: now.tabId }));
        }}
      />
      <IconButton
        icon="add"
        label={`New tab (${HINTS.newTab})`}
        className="ml-1"
        // N-02: the empty tab's Enter then opens a terminal (a focused button would make a tab).
        onMouseDown={keepKeyboard}
        onClick={() => {
          actions.newTab();
        }}
      />
    </div>
  );
}

/** The pill wrappers of `strip`, in order. */
function pills(strip: HTMLElement | null): HTMLElement[] {
  return strip === null
    ? []
    : [...strip.querySelectorAll<HTMLElement>(`[${TAB_ID}]`)].filter(
        (element) => element.parentElement === strip,
      );
}
