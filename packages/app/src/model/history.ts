// N-11: undo and redo of layout and workspace actions, as pure functions. Each undoable change
// records the document before and after it (documents are immutable, so keeping them is cheap);
// undo brings the one before back, redo the one after. What the terminals report meanwhile (a
// folder, an agent that ended) is never undone: a panel in both documents keeps its present
// content. Where the user is looking is kept too, unless the user is still where the change was
// made (then the change's own tab and focus come back). Memory only, bounded.
import type { Document, Layout, PanelContent } from "@wolfcmd/bindings";

import { activeTab, activeWorkspace } from "./document";
import { hasPanel, panelsOf } from "./layout";

/** How many steps undo can go back. */
export const HISTORY_DEPTH = 100;
/** Steps of one group (a divider dragged again, a name typed again) this close merge into one. */
export const GROUP_WINDOW_MS = 1000;

/** An undoable change: what the buttons' tooltips call it ("close panel"). */
export interface Step {
  readonly label: string;
  /** Steps with the same group that follow each other quickly are one step. */
  readonly group?: string;
}

interface Entry {
  readonly label: string;
  readonly group: string | undefined;
  /** When it was recorded (grouping). */
  readonly at: number;
  /** The document undo brings back. */
  readonly before: Document;
  /** The document redo brings back. */
  readonly after: Document;
}

export interface History {
  readonly past: readonly Entry[];
  readonly future: readonly Entry[];
}

export const EMPTY_HISTORY: History = { past: [], future: [] };

/**
 * `history` with the change from `before` to `after` (`step`) as its newest step, at time `now`
 * (ms); the redo steps are gone. A step of the same group as the newest one, within
 * `GROUP_WINDOW_MS`, extends it instead. At most `HISTORY_DEPTH` steps are kept.
 */
export function record(
  history: History,
  before: Document,
  after: Document,
  step: Step,
  now: number,
): History {
  const last = history.past.at(-1);
  if (
    step.group !== undefined &&
    last?.group === step.group &&
    now - last.at < GROUP_WINDOW_MS &&
    history.future.length === 0
  ) {
    return { past: [...history.past.slice(0, -1), { ...last, after, at: now }], future: [] };
  }
  const entry: Entry = { label: step.label, group: step.group, at: now, before, after };
  return { past: [...history.past, entry].slice(-HISTORY_DEPTH), future: [] };
}

/** What undo or redo did. */
export interface Moved {
  readonly history: History;
  readonly document: Document;
  /** The step's label. */
  readonly label: string;
  /** Nothing the user sees changed (it happened in another tab or workspace): say so. */
  readonly offscreen: boolean;
}

/** The newest step undone in `present`, or `undefined` when there is none. */
export function undo(history: History, present: Document): Moved | undefined {
  const entry = history.past.at(-1);
  if (entry === undefined) return undefined;
  const document = restore(entry.before, present, place(present) === place(entry.after));
  return {
    document,
    label: entry.label,
    offscreen: screen(document) === screen(present),
    history: {
      past: history.past.slice(0, -1),
      future: [...history.future, { ...entry, before: document, after: present }],
    },
  };
}

/** The newest undone step done again in `present`, or `undefined` when there is none. */
export function redo(history: History, present: Document): Moved | undefined {
  const entry = history.future.at(-1);
  if (entry === undefined) return undefined;
  const document = restore(entry.after, present, place(present) === place(entry.before));
  return {
    document,
    label: entry.label,
    offscreen: screen(document) === screen(present),
    history: {
      past: [...history.past, { ...entry, before: present, after: document }],
      future: history.future.slice(0, -1),
    },
  };
}

/** The label of what undo would undo (`null`: nothing). */
export function undoLabel(history: History): string | null {
  return history.past.at(-1)?.label ?? null;
}

/** The label of what redo would do again (`null`: nothing). */
export function redoLabel(history: History): string | null {
  return history.future.at(-1)?.label ?? null;
}

const panelIdCache = new WeakMap<Document, readonly string[]>();

function panelIds(doc: Document): readonly string[] {
  let ids = panelIdCache.get(doc);
  if (ids === undefined) {
    ids = doc.workspaces.flatMap((w) =>
      w.tabs.flatMap((t) => (t.layout == null ? [] : panelsOf(t.layout).map((p) => p.id))),
    );
    panelIdCache.set(doc, ids);
  }
  return ids;
}

/**
 * The panels not in `present` that undo or redo can bring back: the core keeps their sessions
 * alive a while (`state_save`'s `undoable`), so they come back running.
 */
export function undoablePanels(history: History, present: Document): string[] {
  const now = new Set(panelIds(present));
  const found = new Set<string>();
  for (const entry of [...history.past, ...history.future]) {
    for (const doc of [entry.before, entry.after]) {
      for (const id of panelIds(doc)) if (!now.has(id)) found.add(id);
    }
  }
  return [...found];
}

/** The shown workspace and its shown tab: where the user is. */
function place(doc: Document): string {
  const workspace = activeWorkspace(doc);
  return `${workspace?.id ?? ""}/${activeTab(workspace)?.id ?? ""}`;
}

/** The arrangement without contents: what a layout shows. */
function shape(layout: Layout): unknown {
  return layout.kind === "panel"
    ? [layout.id, layout.title ?? null]
    : [layout.id, layout.direction, layout.ratios, layout.children.map(shape)];
}

/** What the user sees of a document: the shown workspace, its tab pills and the shown tab. */
function screen(doc: Document): string {
  const workspace = activeWorkspace(doc);
  const tab = activeTab(workspace);
  return JSON.stringify([
    workspace?.id,
    workspace?.name,
    workspace?.folder,
    workspace?.tabs.map((t) => [t.id, t.name]),
    tab?.id,
    tab?.maximized ?? null,
    tab?.layout == null ? null : shape(tab.layout),
  ]);
}

/**
 * `target`'s workspaces, tabs and layouts with `present`'s panel contents (what the terminals
 * reported since). `stayed`: the user is where the step was made, so `target`'s shown workspace,
 * tabs and focus come back with it; otherwise `present`'s stay wherever they still exist.
 */
function restore(target: Document, present: Document, stayed: boolean): Document {
  const contents = new Map<string, PanelContent>();
  for (const workspace of present.workspaces) {
    for (const tab of workspace.tabs) {
      if (tab.layout != null) for (const p of panelsOf(tab.layout)) contents.set(p.id, p.content);
    }
  }
  const withContent = (layout: Layout): Layout => {
    if (layout.kind === "split") {
      const children = layout.children.map(withContent);
      return children.every((child, i) => child === layout.children[i])
        ? layout
        : { ...layout, children };
    }
    const content = contents.get(layout.id);
    return content === undefined || content === layout.content ? layout : { ...layout, content };
  };
  const shownTabs = new Map(present.workspaces.map((w) => [w.id, w]));
  const workspaces = target.workspaces.map((workspace) => {
    const tabs = workspace.tabs.map((tab) => {
      const layout = tab.layout == null ? null : withContent(tab.layout);
      const now = stayed
        ? undefined
        : shownTabs.get(workspace.id)?.tabs.find((t) => t.id === tab.id);
      const focused =
        now?.focused != null && layout != null && hasPanel(layout, now.focused)
          ? now.focused
          : (tab.focused ?? null);
      return layout === (tab.layout ?? null) && focused === (tab.focused ?? null)
        ? tab
        : { ...tab, layout, focused };
    });
    const now = stayed ? undefined : shownTabs.get(workspace.id);
    const activeTabId =
      now?.activeTab != null && tabs.some((t) => t.id === now.activeTab)
        ? now.activeTab
        : (workspace.activeTab ?? null);
    return tabs.every((tab, i) => tab === workspace.tabs[i]) &&
      activeTabId === (workspace.activeTab ?? null)
      ? workspace
      : { ...workspace, tabs, activeTab: activeTabId };
  });
  const active =
    !stayed && present.active != null && workspaces.some((w) => w.id === present.active)
      ? present.active
      : (target.active ?? null);
  return { ...target, workspaces, active };
}
