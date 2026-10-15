// N-03: every tab's panels, of every workspace, in one flat list of absolutely placed cards keyed
// by panel ID: switching workspaces or tabs, splitting, closing or moving a panel never remounts
// a terminal (its shell keeps running). Hidden ones (other tabs) stay mounted, invisible and
// parked off screen.
//
// A change re-renders only the cards it touches: cards are memoized (a box compared by value),
// their callbacks are one function per kind for every panel (keyed by panel ID), each tab's
// geometry is computed again only when its layout or the area changes, and a divider drag moves
// the panels from local ratios, saving once when the pointer is released.
//
// N-03 drag and drop: a panel's header dragged past a few pixels shows a label under the pointer
// and the drop zone under it (the half of a panel on that side: split there; the whole panel:
// swap). Everything during the drag goes through refs, one paint per frame, no React render;
// the drop is one document change. Esc cancels.
//
// N-03 panel types: a card's header and body are its type's (`panels/types.ts`, looked up by the
// content's kind in the registry); a kind nobody registered gets the placeholder card.
//
// N-03 maximize: a tab's maximized panel takes the whole area; its other panels are parked like a
// hidden tab's (same size, off screen, invisible, their terminals hidden), never unmounted, so
// their shells and screens are there when the tiles come back. A drag of a header shows the
// tiles again as it starts.
//
// N-01 motion (Web Animations on the card through a ref, never React state, never the terminal's
// rendering): a new panel settles in (not the ones there at the start); maximize grows the card
// from its tile and restore shrinks it back (a transform from the old box, the card already at
// its new size, so the terminal fits once and never blinks), and the tiles that come back fade
// in; the focused block's accent border fades in and out.
//
// N-06: each card holds its panel's finish glow (`PanelGlow`), played through a ref.
import type { Document, Layout } from "@wolfcmd/bindings";
import { cn, durationToken, easingToken, numberToken } from "@wolfcmd/ui-kit";
import {
  memo,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { Actions } from "../actions";
import {
  activeTab,
  activeWorkspace,
  changePanel,
  maximizedPanel,
  tabName,
  toggleMaximize,
  updateTab,
  workspaceName,
} from "../model/document";
import { type DropTarget, dropTargetAt, pastThreshold, sameTarget, zoneRect } from "../model/drop";
import {
  type Divider,
  dragRatios,
  findSplit,
  geometry,
  type Geometry,
  type PanelLeaf,
  panelsOf,
  type Rect,
  setRatios,
  shares,
} from "../model/layout";
import type { FullSettings } from "../store/settings";
import type { WorkspaceStore } from "../store/workspaces";
import { panelTypes } from "./builtin-types";
import { EmptyTab } from "./EmptyTab";
import { PanelGlow } from "./PanelGlow";
import {
  type LayoutAction,
  type PanelType,
  type PanelTypes,
  type PanelViewProps,
  typeFor,
} from "./types";
import { UNKNOWN_TYPE } from "./UnknownPanel";

/** Pixels between panels when the `--wc-panel-gap` token can't be read. */
const DEFAULT_GAP = 6;
/**
 * N-02: where a hidden tab's cards wait, at their size (no refit, no PTY resize): off screen,
 * so xterm pauses their rendering (it watches whether it intersects the viewport).
 */
const PARKED_LEFT = -32_768;
/** Where the drag label sits from the pointer (below right, like a system drag image). */
const LABEL_OFFSET = { x: 14, y: 10 };

/**
 * A panel's body: its type's view. Memoized, so a terminal re-renders only when its own props
 * change (never for a box or a sibling).
 */
const PanelBody = memo(function PanelBody({
  type,
  ...props
}: PanelViewProps & { readonly type: PanelType }) {
  const View = type.View;
  return <View {...props} />;
});

/** The gap between panels, from its token (the compact density makes it smaller). */
function panelGap(element: Element): number {
  const value = Number.parseFloat(getComputedStyle(element).getPropertyValue("--wc-panel-gap"));
  return Number.isFinite(value) ? value : DEFAULT_GAP;
}

interface Area {
  readonly width: number;
  readonly height: number;
  readonly gap: number;
}

/**
 * Each tab's geometry for the area it was computed in, by layout: a tab whose layout object
 * and area are unchanged keeps its boxes (the same objects), so its cards don't re-render.
 */
const geometries = new WeakMap<Layout, { area: Area; geometry: Geometry }>();

function geometryIn(layout: Layout, area: Area): Geometry {
  const cached = geometries.get(layout);
  if (
    cached?.area.width === area.width &&
    cached.area.height === area.height &&
    cached.area.gap === area.gap
  ) {
    return cached.geometry;
  }
  const placed = geometry(layout, { x: 0, y: 0, width: area.width, height: area.height }, area.gap);
  geometries.set(layout, { area, geometry: placed });
  return placed;
}

const px = (r: Rect) => ({
  left: `${String(r.x)}px`,
  top: `${String(r.y)}px`,
  width: `${String(r.width)}px`,
  height: `${String(r.height)}px`,
});

export interface TabViewProps {
  readonly document: Document;
  readonly store: WorkspaceStore;
  readonly actions: Actions;
  readonly settings: FullSettings;
  /** Each panel's box in the shown tab, for Alt+arrow focus moves. */
  readonly onGeometry: (panels: Geometry["panels"]) => void;
  /** N-03: the panel types cards are drawn with (default: the built-in ones). */
  readonly types?: PanelTypes;
}

/** A divider being dragged: the split's shares so far, shown but not saved yet. */
interface Drag {
  readonly tabId: string;
  readonly splitId: string;
  readonly ratios: readonly number[];
}

/** The callbacks every card shares (each takes the panel's ID). */
interface PanelCallbacks {
  readonly onChange: PanelViewProps["onChange"];
  readonly onFocus: (panelId: string) => void;
  /** N-03: the terminal menu's layout items. */
  readonly onLayout: (panelId: string, action: LayoutAction) => void;
  readonly onDragStart: (
    panelId: string,
    title: string,
    event: ReactPointerEvent<HTMLElement>,
  ) => void;
}

export function TabView({
  document: doc,
  store,
  actions,
  settings,
  onGeometry,
  types = panelTypes,
}: TabViewProps) {
  const area = useRef<HTMLDivElement>(null);
  const zone = useRef<HTMLDivElement>(null);
  const source = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Area>({ width: 0, height: 0, gap: DEFAULT_GAP });
  const [drag, setDrag] = useState<Drag | undefined>(undefined);
  /** The shown tab's boxes as last rendered (the panel drag reads them when it starts). */
  const shownBoxes = useRef<Geometry["panels"]>(new Map());

  // The panel area's size and gap (an external system: the window and the density).
  useEffect(() => {
    const element = area.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      const next = {
        width: element.clientWidth,
        height: element.clientHeight,
        gap: panelGap(element),
      };
      setSize((now) =>
        now.width === next.width && now.height === next.height && now.gap === next.gap ? now : next,
      );
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  const callbacks = useMemo<PanelCallbacks>(
    () => ({
      onChange: (panelId, change) => {
        store.apply((d) => changePanel(d, panelId, change));
      },
      onFocus: (panelId) => {
        actions.focusPanel(panelId);
      },
      onLayout: (panelId, action) => {
        if (action === "maximize") actions.toggleMaximize(panelId);
        else actions.splitPanel(panelId, action === "splitRight" ? "right" : "down");
      },
      onDragStart: (panelId, title, event) => {
        const container = area.current;
        const overlay = zone.current;
        const swapped = source.current;
        const ghost = label.current;
        if (container === null || overlay === null || swapped === null || ghost === null) return;
        dragPanel({
          panelId,
          title,
          event,
          container,
          overlay,
          swapped,
          ghost,
          panels: () => shownBoxes.current,
          // N-03: a drag ends the maximize, so the other panels are there to drop on.
          begin: () => {
            const tab = activeTab(activeWorkspace(store.getState().document));
            const maximized = maximizedPanel(tab);
            if (maximized !== undefined) store.apply((d) => toggleMaximize(d, maximized));
          },
          drop: (target) => {
            actions.dropPanel(panelId, target.panelId, target.zone);
          },
        });
      },
    }),
    [store, actions],
  );

  const shownWorkspace = activeWorkspace(doc);
  const shownTab = activeTab(shownWorkspace);
  // N-02: no panel mounts before the area has its size. A terminal mounted in a 0×0 box opens
  // its session at 2×1, and attaching at that size reflowed a running shell (a reload left a
  // garbled screen with the cursor at the top left).
  const measured = size.width > 0 && size.height > 0;
  // While a divider is dragged, its tab's layout with the drag's shares: made once per drag
  // step, so its geometry stays cached across other renders.
  const dragBase =
    drag === undefined
      ? undefined
      : doc.workspaces.flatMap((w) => w.tabs).find((t) => t.id === drag.tabId)?.layout;
  const dragged = useMemo(
    () =>
      drag === undefined || dragBase == null
        ? undefined
        : setRatios(dragBase, drag.splitId, drag.ratios),
    [drag, dragBase],
  );
  const placed = !measured
    ? []
    : doc.workspaces.flatMap((workspace) =>
        workspace.tabs.flatMap((tab) => {
          if (tab.layout == null) return [];
          // While a divider of this tab is dragged, its shares come from the drag.
          const layout = drag?.tabId === tab.id && dragged !== undefined ? dragged : tab.layout;
          return [
            {
              workspace,
              tab,
              layout,
              geometry: geometryIn(layout, size),
              maximized: maximizedPanel(tab),
            },
          ];
        }),
      );
  const shown = placed.find((p) => p.tab.id === shownTab?.id);
  /** N-03: a maximized panel's box: the whole area. */
  const whole: Rect = { x: 0, y: 0, width: size.width, height: size.height };

  // N-01: cards that mount from now on are new panels (they settle in); the first ones don't.
  useEffect(() => {
    if (measured && area.current !== null) area.current.dataset.settled = "";
  }, [measured]);

  useEffect(() => {
    const boxes =
      shown?.maximized !== undefined
        ? new Map([[shown.maximized, whole]])
        : (shown?.geometry.panels ?? new Map<string, Rect>());
    shownBoxes.current = boxes;
    onGeometry(boxes);
  });

  return (
    <div ref={area} className="relative min-h-0 flex-1">
      {placed.flatMap(({ workspace, tab, layout, geometry: tabGeometry, maximized }) => {
        const tabVisible = tab.id === shownTab?.id;
        const names = { workspace: workspaceName(doc, workspace), tab: tabName(workspace, tab) };
        const leaves = panelsOf(layout);
        return leaves.map((panel) => {
          const tiled = tabGeometry.panels.get(panel.id);
          if (tiled === undefined) return null;
          // N-03: the maximized panel fills the area; the others wait parked, at their size.
          const filling = maximized === panel.id;
          const visible = tabVisible && (maximized === undefined || filling);
          return (
            <PanelCard
              key={panel.id}
              panel={panel}
              rect={filling ? whole : tiled}
              visible={visible}
              focused={visible && tab.focused === panel.id}
              alone={leaves.length === 1}
              maximized={filling}
              parked={tabVisible && maximized !== undefined && !filling}
              folder={workspace.folder ?? null}
              workspaceName={names.workspace}
              tabName={names.tab}
              settings={settings}
              actions={actions}
              callbacks={callbacks}
              types={types}
            />
          );
        });
      })}
      {shownTab !== undefined && shown !== undefined && shown.maximized === undefined && (
        <Dividers
          geometry={shown.geometry}
          layout={shown.tab.layout ?? shown.layout}
          gap={size.gap}
          onDrag={(splitId, ratios) => {
            setDrag({ tabId: shown.tab.id, splitId, ratios });
          }}
          onDrop={(splitId, ratios) => {
            setDrag(undefined);
            if (ratios === undefined) return;
            store.apply((d) =>
              updateTab(d, shown.tab.id, (t) =>
                t.layout == null ? t : { ...t, layout: setRatios(t.layout, splitId, ratios) },
              ),
            );
          }}
        />
      )}
      {/* N-03: where the dragged panel would land; placed through refs during a drag, it fades
          and grows in and glides between zones. */}
      <div
        ref={zone}
        aria-hidden
        data-drop-zone=""
        className={cn(
          "pointer-events-none absolute z-20 rounded-overlay border-2 border-accent bg-accent-tint",
          "scale-98 opacity-0 data-[shown]:scale-100 data-[shown]:opacity-100",
          "transition-[left,top,width,height,opacity,scale] duration-(--wc-dur-fast) ease-out",
        )}
      />
      {/* On a swap (the centre), where the other panel goes. */}
      <div
        ref={source}
        aria-hidden
        className={cn(
          "pointer-events-none absolute z-20 rounded-overlay border-2 border-dashed border-accent-line",
          "opacity-0 transition-opacity duration-(--wc-dur-fast) ease-out data-[shown]:opacity-100",
        )}
      />
      {/* The dragged panel's name under the pointer (no browser drag image). */}
      <div
        ref={label}
        aria-hidden
        style={{ display: "none" }}
        className="wc-surface-flyout pointer-events-none fixed top-0 left-0 z-50 max-w-64 truncate rounded-control px-3 py-1.5 text-sm font-medium will-change-transform"
      />
      {shownTab?.layout == null && <EmptyTab actions={actions} />}
    </div>
  );
}

interface PanelDrag {
  readonly panelId: string;
  readonly title: string;
  readonly event: ReactPointerEvent<HTMLElement>;
  /** The panel area (drop zones are in its coordinates). */
  readonly container: HTMLElement;
  readonly overlay: HTMLElement;
  readonly swapped: HTMLElement;
  readonly ghost: HTMLElement;
  /** The shown tab's panels now, in the area's coordinates (read each frame). */
  readonly panels: () => ReadonlyMap<string, Rect>;
  /** The drag starts (past the threshold). */
  readonly begin: () => void;
  readonly drop: (target: DropTarget) => void;
}

/**
 * N-03: drags a panel by its header with pointer events: a threshold first (a click stays a
 * click), then one paint per frame of the label and the zone, all through the DOM; the drop is
 * one call. Esc (captured, so the terminal never sees it) or a lost pointer cancels.
 */
function dragPanel({
  panelId,
  title,
  event,
  container,
  overlay,
  swapped,
  ghost,
  panels,
  begin: onBegin,
  drop,
}: PanelDrag) {
  const handle = event.currentTarget;
  const pointerId = event.pointerId;
  const start = { x: event.clientX, y: event.clientY };
  const origin = container.getBoundingClientRect();
  const card =
    [...container.querySelectorAll<HTMLElement>("[data-panel]")].find(
      (element) => element.dataset.panel === panelId,
    ) ?? null;
  let pointer = start;
  let labelWidth = 0;
  let dragging = false;
  let target: DropTarget | undefined;
  let frame = 0;

  const show = (next: DropTarget | undefined) => {
    if (sameTarget(target, next)) return;
    target = next;
    const rect = next === undefined ? undefined : panels().get(next.panelId);
    if (next === undefined || rect === undefined) {
      delete overlay.dataset.shown;
      delete swapped.dataset.shown;
      return;
    }
    Object.assign(overlay.style, px(zoneRect(rect, next.zone)));
    overlay.dataset.shown = "";
    overlay.dataset.zone = next.zone;
    const own = panels().get(panelId);
    if (next.zone === "center" && own !== undefined) {
      Object.assign(swapped.style, px(own));
      swapped.dataset.shown = "";
    } else {
      delete swapped.dataset.shown;
    }
  };

  const paint = () => {
    frame = 0;
    // Below right of the pointer, kept inside the window.
    const x = Math.max(
      0,
      Math.min(pointer.x + LABEL_OFFSET.x, window.innerWidth - labelWidth - LABEL_OFFSET.x),
    );
    ghost.style.transform = `translate(${String(x)}px, ${String(pointer.y + LABEL_OFFSET.y)}px)`;
    show(dropTargetAt(pointer.x - origin.left, pointer.y - origin.top, panelId, panels()));
  };

  const begin = () => {
    dragging = true;
    onBegin();
    ghost.textContent = title;
    ghost.style.display = "block";
    labelWidth = ghost.offsetWidth;
    container.dataset.dragging = "";
    if (card !== null) card.style.opacity = "var(--wc-drag-dim)";
  };

  const finish = (dropped: boolean) => {
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onUp);
    handle.removeEventListener("pointercancel", onCancel);
    handle.removeEventListener("lostpointercapture", onCancel);
    window.removeEventListener("keydown", onKey, { capture: true });
    if (frame !== 0) {
      cancelAnimationFrame(frame);
      if (dropped && dragging) paint();
    }
    frame = 0;
    if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    if (!dragging) return;
    dragging = false;
    const landed = dropped ? target : undefined;
    show(undefined);
    ghost.style.display = "none";
    delete container.dataset.dragging;
    if (card !== null) card.style.opacity = "";
    if (landed !== undefined) drop(landed);
  };

  const onMove = (moved: PointerEvent) => {
    pointer = { x: moved.clientX, y: moved.clientY };
    if (!dragging) {
      if (!pastThreshold(pointer.x - start.x, pointer.y - start.y)) return;
      begin();
    }
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
  // The header keeps the pointer from the press on, however fast it moves.
  handle.setPointerCapture(pointerId);
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("pointercancel", onCancel);
  handle.addEventListener("lostpointercapture", onCancel);
  window.addEventListener("keydown", onKey, { capture: true });
}

interface PanelCardProps {
  readonly panel: PanelLeaf;
  readonly rect: Rect;
  readonly visible: boolean;
  readonly focused: boolean;
  /** The tab's only panel: its border lights up only while it has the keyboard. */
  readonly alone: boolean;
  /** N-03: it fills its tab (the others are parked). */
  readonly maximized: boolean;
  /** N-03: another panel of the shown tab is maximized: this one waits out of sight. */
  readonly parked: boolean;
  readonly folder: string | null;
  readonly workspaceName: string;
  readonly tabName: string;
  readonly settings: FullSettings;
  readonly actions: Actions;
  readonly callbacks: PanelCallbacks;
  readonly types: PanelTypes;
}

const sameRect = (a: Rect, b: Rect) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** What a card was at its last render (its motion starts from there). */
interface CardState {
  readonly rect: Rect;
  readonly visible: boolean;
  readonly maximized: boolean;
  readonly parked: boolean;
}

/**
 * N-01: a card's motion after a render, from what it was (`before`, undefined: it just mounted).
 * The card already has its new box; only a transform and opacity animate, on the compositor.
 */
function cardMotion(card: HTMLElement, before: CardState | undefined, now: CardState): void {
  if (!now.visible || typeof card.animate !== "function") return;
  // What moves (decided before any token is read: most renders move nothing).
  const kind =
    before === undefined
      ? // A new panel (a split, a new tab's first panel); not the ones there at the start.
        card.parentElement?.dataset.settled === undefined
        ? undefined
        : "enter"
      : before.visible && before.maximized !== now.maximized && !sameRect(before.rect, now.rect)
        ? "grow"
        : before.parked && !now.parked
          ? "return"
          : undefined;
  if (kind === undefined) return;
  const ms = durationToken(kind === "grow" ? "dur-slow" : "dur-normal");
  if (ms <= 0) return;
  const easing = easingToken("ease-out");
  if (kind === "enter") {
    const from = numberToken("enter-scale", 1);
    card.animate(
      [
        { opacity: 0, transform: `scale(${String(from)})` },
        { opacity: 1, transform: "none" },
      ],
      { duration: ms, easing },
    );
  } else if (kind === "grow" && before !== undefined) {
    // Maximize grows the card from its tile; restore shrinks it back into it.
    const from = before.rect;
    const to = now.rect;
    if (to.width <= 0 || to.height <= 0) return;
    const sx = from.width / to.width;
    const sy = from.height / to.height;
    const transform = `translate(${String(from.x - to.x)}px, ${String(from.y - to.y)}px) scale(${String(sx)}, ${String(sy)})`;
    card.animate(
      [
        { transformOrigin: "0 0", transform },
        { transformOrigin: "0 0", transform: "none" },
      ],
      { duration: ms, easing },
    );
  } else {
    // The tiles a restore brings back fade in.
    card.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms, easing });
  }
}

/** A panel's card: its type's header on top, its type's view below. Re-rendered only when its
 * own props change (its box compared by value) or a panel type is registered. */
const PanelCard = memo(
  function PanelCard({
    panel,
    rect,
    visible,
    focused,
    alone,
    maximized,
    parked,
    folder,
    workspaceName: workspaceLabel,
    tabName: tabLabel,
    settings,
    actions,
    callbacks,
    types,
  }: PanelCardProps) {
    const registered = useSyncExternalStore(types.subscribe, types.list);
    const type = typeFor(registered, panel.content.kind) ?? UNKNOWN_TYPE;
    const Header = type.Header;
    // Alone on screen (its tab's only panel, or maximized): the border lights with the keyboard.
    const solo = alone || maximized;
    // N-01: its motion, through the DOM (a ref and Web Animations), after each of its renders.
    const card = useRef<HTMLDivElement>(null);
    const last = useRef<CardState>(undefined);
    useLayoutEffect(() => {
      const now = { rect, visible, maximized, parked };
      const before = last.current;
      last.current = now;
      if (card.current !== null) cardMotion(card.current, before, now);
    }, [rect, visible, maximized, parked]);
    return (
      <div
        ref={card}
        // Lets the end-to-end tests (`tests/e2e`) find a panel and see which one has the keyboard.
        data-panel={panel.id}
        data-focused={focused || undefined}
        className={cn(
          "group/block absolute overflow-hidden rounded-overlay border bg-bg",
          "transition-[border-color,opacity] duration-(--wc-dur-normal) ease-out",
          // N-01: the focused block's border is the accent: the one sign of where the keyboard is.
          focused && !solo ? "border-(--wc-block-focus)" : "border-line",
          focused && solo && "focus-within:border-(--wc-block-focus)",
          !visible && "invisible",
        )}
        style={{
          left: visible ? rect.x : PARKED_LEFT,
          top: rect.y,
          width: rect.width,
          height: rect.height,
        }}
      >
        <Header
          panel={panel}
          visible={visible}
          focused={focused}
          folder={folder}
          alone={alone}
          maximized={maximized}
          actions={actions}
          onDragStart={callbacks.onDragStart}
        />
        <div className="absolute inset-x-0 bottom-0 top-(--wc-header-h) overflow-hidden">
          <PanelBody
            type={type}
            panel={panel}
            folder={folder}
            workspaceName={workspaceLabel}
            tabName={tabLabel}
            focused={focused}
            visible={visible}
            settings={settings}
            actions={actions}
            onChange={callbacks.onChange}
            onFocus={callbacks.onFocus}
            alone={alone}
            maximized={maximized}
            onLayout={callbacks.onLayout}
          />
        </div>
        {/* N-06: the finish reward along this block's edge; it plays outside React, so this
            card never re-renders for it. */}
        <PanelGlow panelId={panel.id} />
      </div>
    );
  },
  (before, after) =>
    sameRect(before.rect, after.rect) &&
    (Object.keys(before) as (keyof PanelCardProps)[]).every(
      (key) => key === "rect" || Object.is(before[key], after[key]),
    ),
);

/** A divider's key (and `data-divider`): its split and its place in it. */
const dividerKey = (divider: Divider) => `${divider.splitId}-${String(divider.index)}`;

/**
 * The lines between split children. Dragging one moves its neighbors from local shares
 * (`onDrag`, at most once a frame); releasing it saves them once (`onDrop`); a cancelled drag
 * (or one whose divider went away) puts them back (`onDrop` without shares). A line lights up
 * after a short rest under the pointer (no flicker when passing over it), at once while dragged.
 */
function Dividers({
  geometry: placed,
  layout,
  gap,
  onDrag,
  onDrop,
}: {
  readonly geometry: Geometry;
  /** The tab's saved layout (the shares a drag starts from). */
  readonly layout: Layout;
  readonly gap: number;
  readonly onDrag: (splitId: string, ratios: number[]) => void;
  readonly onDrop: (splitId: string, ratios: number[] | undefined) => void;
}) {
  /** The divider being dragged: its key, its split's size, and how to end its drag. */
  const active = useRef<{
    readonly key: string;
    readonly splitId: string;
    readonly count: number;
    readonly finish: (save: boolean) => void;
  }>(undefined);
  // N-03: a drag whose divider went away (another tab shown, a panel maximized or closed by the
  // keyboard) ends unsaved: its pointerup would go to a removed node, and the tab would keep
  // showing shares that were never saved.
  useEffect(() => {
    const now = active.current;
    if (now === undefined) return;
    const still =
      placed.dividers.some((d) => dividerKey(d) === now.key) &&
      findSplit(layout, now.splitId)?.children.length === now.count;
    if (!still) now.finish(false);
  });
  useEffect(
    () => () => {
      active.current?.finish(false);
    },
    [],
  );
  const drag = (divider: Divider, event: React.PointerEvent<HTMLDivElement>) => {
    const split = findSplit(layout, divider.splitId);
    if (split === undefined) return;
    active.current?.finish(false);
    const startRatios = shares(split);
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    target.setPointerCapture(pointerId);
    target.dataset.dragging = "";
    const origin = target.parentElement?.getBoundingClientRect() ?? { left: 0, top: 0 };
    let frame = 0;
    let last = { x: event.clientX, y: event.clientY };
    let ratios: number[] | undefined;
    const at = () => {
      const position = divider.direction === "row" ? last.x - origin.left : last.y - origin.top;
      return dragRatios(startRatios, divider, position, gap);
    };
    const move = (moved: PointerEvent) => {
      last = { x: moved.clientX, y: moved.clientY };
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        ratios = at();
        onDrag(divider.splitId, ratios);
      });
    };
    const finish = (save: boolean) => {
      if (active.current?.finish !== finish) return;
      active.current = undefined;
      cancelAnimationFrame(frame);
      frame = 0;
      delete target.dataset.dragging;
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", cancel);
      target.removeEventListener("lostpointercapture", cancel);
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
      // The shares where the pointer was released (also when its last move had no frame yet).
      onDrop(divider.splitId, save && ratios !== undefined ? at() : undefined);
    };
    const up = () => {
      finish(true);
    };
    const cancel = () => {
      finish(false);
    };
    active.current = {
      key: dividerKey(divider),
      splitId: divider.splitId,
      count: split.children.length,
      finish,
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", cancel);
    target.addEventListener("lostpointercapture", cancel);
  };
  return (
    <>
      {placed.dividers.map((divider) => (
        <div
          key={`${divider.splitId}-${String(divider.index)}`}
          data-divider={`${divider.splitId}-${String(divider.index)}`}
          className={cn(
            "group absolute z-10 flex items-center justify-center",
            divider.direction === "row" ? "cursor-col-resize" : "cursor-row-resize",
          )}
          style={{
            left: divider.rect.x,
            top: divider.rect.y,
            width: divider.rect.width,
            height: divider.rect.height,
          }}
          onPointerDown={(event) => {
            drag(divider, event);
          }}
        >
          <span
            aria-hidden
            className={cn(
              "rounded-full bg-transparent transition-colors duration-(--wc-dur-fast) ease-out",
              "group-hover:bg-fill-strong group-hover:delay-(--wc-delay-hover)",
              "group-data-[dragging]:bg-line-strong group-data-[dragging]:delay-0",
              divider.direction === "row" ? "h-8 w-0.5" : "h-0.5 w-8",
            )}
          />
        </div>
      ))}
    </>
  );
}
