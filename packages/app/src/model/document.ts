// N-03 / N-04: the workspace document as pure functions, the Wave model: a
// workspace (a name and an optional folder) holds tabs; a tab is tiled panels. There is always
// at least one workspace, and every workspace has at least one tab.
import type { Document, Layout, Panel, Tab, Workspace } from "@wolfcmd/bindings";

import type { Zone } from "./drop";
import {
  hasPanel,
  leaf,
  movePanel,
  panelsOf,
  removePanel,
  type Side,
  splitPanel,
  swapPanels,
  updatePanel,
} from "./layout";
import type { PanelLeaf } from "./layout";
import { changeTerminal } from "./panels";

export type NewId = () => string;

/** The document format this UI writes (`wcmd_state::CURRENT_VERSION`; N-03: 2, panel types). */
const DOCUMENT_VERSION = 2;

/** The last part of a folder path (`C:\dev\app\` → `app`). */
export function folderName(folder: string): string {
  const parts = folder.split(/[\\/]+/).filter((part) => part !== "");
  return parts.at(-1) ?? folder;
}

/**
 * A folder's identity: separators and trailing slashes normalized, Windows drive and UNC paths
 * without case (POSIX paths keep it).
 */
export function folderKey(folder: string): string {
  const normalized = folder.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[a-z]:/i.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}

/** The workspace shown. */
export function activeWorkspace(doc: Document): Workspace | undefined {
  return doc.workspaces.find((w) => w.id === doc.active) ?? doc.workspaces[0];
}

/** The tab shown in `workspace`. */
export function activeTab(workspace: Workspace | undefined): Tab | undefined {
  return workspace?.tabs.find((t) => t.id === workspace.activeTab) ?? workspace?.tabs[0];
}

/**
 * A workspace's name: the user's, else its folder's, else its position ("Workspace 2"), found by
 * ID (so a copy, such as a rename's placeholder, gets the same).
 */
export function workspaceName(doc: Document, workspace: Workspace): string {
  const name = workspace.name?.trim() ?? "";
  if (name !== "") return name;
  if (workspace.folder != null) return folderName(workspace.folder);
  return `Workspace ${String(doc.workspaces.findIndex((w) => w.id === workspace.id) + 1)}`;
}

/** A tab's name: the user's, else its position ("Tab 2"). */
export function tabName(workspace: Workspace, tab: Tab): string {
  const name = tab.name?.trim() ?? "";
  return name === "" ? `Tab ${String(workspace.tabs.indexOf(tab) + 1)}` : name;
}

const emptyTab = (newId: NewId): Tab => ({ id: newId(), name: "", layout: null, focused: null });

function emptyWorkspace(folder: string | null, newId: NewId): Workspace {
  const tab = emptyTab(newId);
  return { id: newId(), name: "", folder, tabs: [tab], activeTab: tab.id };
}

/** A document with one empty workspace (the first start). */
export function emptyDocument(newId: NewId): Document {
  const workspace = emptyWorkspace(null, newId);
  return { version: DOCUMENT_VERSION, workspaces: [workspace], active: workspace.id };
}

/** A new workspace (one empty tab) for `folder`, shown. */
export function createWorkspace(doc: Document, folder: string | null, newId: NewId): Document {
  const workspace = emptyWorkspace(folder, newId);
  return { ...doc, workspaces: [...doc.workspaces, workspace], active: workspace.id };
}

/** The workspace whose folder is `folder`, if one has it. */
export function workspaceForFolder(doc: Document, folder: string): Workspace | undefined {
  return doc.workspaces.find((w) => w.folder != null && folderKey(w.folder) === folderKey(folder));
}

/**
 * Without workspace `id`; a neighbor is shown. The last one becomes a new empty workspace.
 * N-10: its worktree workspaces stay, as plain workspaces.
 */
export function closeWorkspace(doc: Document, id: string, newId: NewId): Document {
  const index = doc.workspaces.findIndex((w) => w.id === id);
  if (index < 0) return doc;
  const workspaces = doc.workspaces
    .filter((w) => w.id !== id)
    .map((w) => (w.main === id ? { ...w, main: null } : w));
  if (workspaces.length === 0) return emptyDocument(newId);
  const active =
    doc.active === id
      ? (workspaces[Math.min(index, workspaces.length - 1)]?.id ?? null)
      : (doc.active ?? null);
  return { ...doc, workspaces, active };
}

export function activateWorkspace(doc: Document, id: string): Document {
  return doc.workspaces.some((w) => w.id === id) ? { ...doc, active: id } : doc;
}

export function updateWorkspace(
  doc: Document,
  id: string,
  change: (workspace: Workspace) => Workspace,
): Document {
  return { ...doc, workspaces: doc.workspaces.map((w) => (w.id === id ? change(w) : w)) };
}

/** The shown workspace changed by `change`. */
function updateActive(doc: Document, change: (workspace: Workspace) => Workspace): Document {
  const workspace = activeWorkspace(doc);
  return workspace === undefined ? doc : updateWorkspace(doc, workspace.id, change);
}

/** A new empty tab in the shown workspace, shown. */
export function addTab(doc: Document, newId: NewId): Document {
  const tab = emptyTab(newId);
  return updateActive(doc, (w) => ({ ...w, tabs: [...w.tabs, tab], activeTab: tab.id }));
}

/** Without tab `tabId`; a neighbor is shown. A workspace's last tab becomes a new empty one. */
export function closeTab(doc: Document, tabId: string, newId: NewId): Document {
  const owner = doc.workspaces.find((w) => w.tabs.some((t) => t.id === tabId));
  if (owner === undefined) return doc;
  return updateWorkspace(doc, owner.id, (w) => {
    const index = w.tabs.findIndex((t) => t.id === tabId);
    const tabs = w.tabs.filter((t) => t.id !== tabId);
    if (tabs.length === 0) {
      const tab = emptyTab(newId);
      return { ...w, tabs: [tab], activeTab: tab.id };
    }
    const activeTabId =
      w.activeTab === tabId
        ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null)
        : (w.activeTab ?? null);
    return { ...w, tabs, activeTab: activeTabId };
  });
}

export function activateTab(doc: Document, tabId: string): Document {
  const owner = doc.workspaces.find((w) => w.tabs.some((t) => t.id === tabId));
  if (owner === undefined) return doc;
  return {
    ...updateWorkspace(doc, owner.id, (w) => ({ ...w, activeTab: tabId })),
    active: owner.id,
  };
}

/** The tab `step` places after (or before) the shown one, wrapping around. */
export function cycleTab(doc: Document, step: 1 | -1): Document {
  return updateActive(doc, (w) => {
    const count = w.tabs.length;
    if (count < 2) return w;
    const index = Math.max(
      0,
      w.tabs.findIndex((t) => t.id === w.activeTab),
    );
    const next = w.tabs[(index + step + count) % count];
    return next === undefined ? w : { ...w, activeTab: next.id };
  });
}

/** The shown workspace's tab number `n` (1-based), shown. */
export function activateTabNumber(doc: Document, n: number): Document {
  const tab = activeWorkspace(doc)?.tabs[n - 1];
  return tab === undefined ? doc : activateTab(doc, tab.id);
}

/** Tab `tabId` moved to position `to` in its workspace (a pill dragged along the title bar). */
export function moveTab(doc: Document, tabId: string, to: number): Document {
  const owner = doc.workspaces.find((w) => w.tabs.some((t) => t.id === tabId));
  if (owner === undefined) return doc;
  return updateWorkspace(doc, owner.id, (w) => {
    const moving = w.tabs.find((t) => t.id === tabId);
    if (moving === undefined) return w;
    const tabs = w.tabs.filter((t) => t.id !== tabId);
    tabs.splice(Math.max(0, Math.min(to, tabs.length)), 0, moving);
    return { ...w, tabs };
  });
}

/**
 * N-03: a copy of tab `tabId` right after it, shown: the same layout, folders and name with new
 * tab, split and panel IDs (fresh shells), agent panels as fresh agents (a new session, as in a
 * copied worktree tab). Returns the document and the copy's panel IDs.
 */
export function duplicateTab(
  doc: Document,
  tabId: string,
  newId: NewId,
): { readonly document: Document; readonly panels: readonly string[] } {
  const owner = doc.workspaces.find((w) => w.tabs.some((t) => t.id === tabId));
  const tab = owner?.tabs.find((t) => t.id === tabId);
  if (owner === undefined || tab === undefined) return { document: doc, panels: [] };
  const copy = copyTab(tab, (f) => f, newId);
  const document = updateWorkspace(doc, owner.id, (w) => {
    const tabs = [...w.tabs];
    tabs.splice(tabs.indexOf(tab) + 1, 0, copy);
    return { ...w, tabs, activeTab: copy.id };
  });
  return {
    document: activateTab(document, copy.id),
    panels: copy.layout == null ? [] : panelsOf(copy.layout).map((p) => p.id),
  };
}

/** N-03: only tab `tabId` is left in its workspace, shown. */
export function closeOtherTabs(doc: Document, tabId: string): Document {
  const owner = doc.workspaces.find((w) => w.tabs.some((t) => t.id === tabId));
  if (owner === undefined || owner.tabs.length < 2) return doc;
  return updateWorkspace(doc, owner.id, (w) => ({
    ...w,
    tabs: w.tabs.filter((t) => t.id === tabId),
    activeTab: tabId,
  }));
}

/** N-03: the tabs after `tabId` in its workspace are closed; the shown one stays when it is left. */
export function closeTabsToRight(doc: Document, tabId: string): Document {
  const owner = doc.workspaces.find((w) => w.tabs.some((t) => t.id === tabId));
  if (owner === undefined) return doc;
  const index = owner.tabs.findIndex((t) => t.id === tabId);
  if (index === owner.tabs.length - 1) return doc;
  return updateWorkspace(doc, owner.id, (w) => {
    const tabs = w.tabs.slice(0, index + 1);
    const shown = tabs.some((t) => t.id === w.activeTab) ? (w.activeTab ?? null) : tabId;
    return { ...w, tabs, activeTab: shown };
  });
}

/** Tab `tabId` changed by `change`, wherever it is. */
export function updateTab(doc: Document, tabId: string, change: (tab: Tab) => Tab): Document {
  return {
    ...doc,
    workspaces: doc.workspaces.map((w) =>
      w.tabs.some((t) => t.id === tabId)
        ? { ...w, tabs: w.tabs.map((t) => (t.id === tabId ? change(t) : t)) }
        : w,
    ),
  };
}

/** The tab that holds panel `panelId`. */
function tabWith(doc: Document, panelId: string): Tab | undefined {
  return doc.workspaces
    .flatMap((w) => w.tabs)
    .find((t) => t.layout != null && hasPanel(t.layout, panelId));
}

/** `panel` in the shown tab, next to its focused panel (`side`, default right), focused. */
export function openPanel(doc: Document, panel: Panel, side: Side, newId: NewId): Document {
  const tab = activeTab(activeWorkspace(doc));
  if (tab === undefined) return doc;
  return updateTab(doc, tab.id, (t) => {
    if (t.layout == null) return { ...t, layout: leaf(panel), focused: panel.id };
    const near =
      t.focused != null && hasPanel(t.layout, t.focused)
        ? t.focused
        : (panelsOf(t.layout)[0]?.id ?? "");
    // N-03: a split ends the maximize (the new panel shows next to its neighbor).
    return {
      ...t,
      layout: splitPanel(t.layout, near, side, panel, newId()),
      focused: panel.id,
      maximized: null,
    };
  });
}

/** Without panel `panelId`; when it had the focus, the first panel left gets it. */
export function closePanel(doc: Document, panelId: string): Document {
  const tab = tabWith(doc, panelId);
  if (tab?.layout == null) return doc;
  const layout = removePanel(tab.layout, panelId) ?? null;
  const focused =
    tab.focused === panelId || layout === null
      ? layout === null
        ? null
        : (panelsOf(layout)[0]?.id ?? null)
      : (tab.focused ?? null);
  // N-03: closing the maximized panel (or all but one) shows the tiles again.
  const maximized =
    tab.maximized === panelId || layout === null || panelsOf(layout).length < 2
      ? null
      : (tab.maximized ?? null);
  return updateTab(doc, tab.id, (t) => ({ ...t, layout, focused, maximized }));
}

/**
 * Panel `panelId` changed by `change`, wherever it is. N-03: the same document when nothing
 * changed (a shell reporting the folder it is already in), so nothing re-renders or is saved.
 */
export function changePanel(
  doc: Document,
  panelId: string,
  change: (panel: PanelLeaf) => PanelLeaf,
): Document {
  const tab = tabWith(doc, panelId);
  if (tab?.layout == null) return doc;
  const current = panelsOf(tab.layout).find((p) => p.id === panelId);
  if (current === undefined) return doc;
  const next = change(current);
  if (sameValue(current, next)) return doc;
  const layout = tab.layout;
  return updateTab(doc, tab.id, (t) => ({
    ...t,
    layout: updatePanel(layout, panelId, () => next),
  }));
}

/** Equal fields, two levels of nested objects deep (a panel, its `content` and its `agent`). */
function sameValue(a: unknown, b: unknown, depth = 3): boolean {
  if (Object.is(a, b)) return true;
  if (depth === 0 || typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => key in right && sameValue(left[key], right[key], depth - 1))
  );
}

/**
 * N-03: panel `panelId` dropped on `zone` of `targetId` (a panel of the same tab): a side
 * splits there, the centre swaps the two. The moved panel keeps its ID (its terminal keeps
 * running) and gets the focus. The same document when nothing moves.
 */
export function dropPanel(
  doc: Document,
  panelId: string,
  targetId: string,
  zone: Zone,
  newId: NewId,
): Document {
  const tab = tabWith(doc, panelId);
  if (tab?.layout == null || !hasPanel(tab.layout, targetId) || panelId === targetId) return doc;
  const layout =
    zone === "center"
      ? swapPanels(tab.layout, panelId, targetId)
      : movePanel(tab.layout, panelId, targetId, zone, newId());
  if (layout === tab.layout) return doc;
  // N-03: a drop ends the maximize.
  return updateTab(doc, tab.id, (t) => ({ ...t, layout, focused: panelId, maximized: null }));
}

/** How many workspace accent colors there are (`--wc-workspace-1` … `-8`). */
export const WORKSPACE_COLORS = 8;

/**
 * N-01: a workspace's accent color (1–8, `--wc-workspace-<n>`): its switcher dot and its
 * focused panel's border. Taken from its ID, so it never changes while the workspace lives;
 * a worktree workspace shares its main workspace's color.
 */
export function workspaceColor(doc: Document, workspace: Workspace): number {
  const owner = mainOf(doc, workspace) ?? workspace;
  let hash = 2166136261;
  for (let i = 0; i < owner.id.length; i++) {
    hash = Math.imul(hash ^ owner.id.charCodeAt(i), 16777619);
  }
  return ((hash >>> 0) % WORKSPACE_COLORS) + 1;
}

/**
 * Panel `panelId` gets the focus in its tab. N-03: a panel hidden behind a maximized one shows
 * the tiles again (a hidden panel never has the keyboard).
 */
export function focusPanel(doc: Document, panelId: string): Document {
  const tab = tabWith(doc, panelId);
  if (tab === undefined) return doc;
  const hidden = maximizedPanel(tab) !== undefined && maximizedPanel(tab) !== panelId;
  if (tab.focused === panelId && !hidden) return doc;
  return updateTab(doc, tab.id, (t) => ({
    ...t,
    focused: panelId,
    ...(hidden ? { maximized: null } : {}),
  }));
}

// N-03: a maximized panel fills its tab; the others stay mounted, parked and hidden, and keep
// their shells. Saved in the document (`Tab.maximized`), so a restart shows it again.

/** The panel that fills `tab`: one of its panels, while it has others (else none). */
export function maximizedPanel(tab: Tab | undefined): string | undefined {
  const id = tab?.maximized;
  if (id == null || tab?.layout == null) return undefined;
  const panels = panelsOf(tab.layout);
  return panels.length > 1 && panels.some((p) => p.id === id) ? id : undefined;
}

/**
 * Panel `panelId` fills its tab and gets the focus; when it already does, the tab shows its
 * tiles again. A tab's only panel can't be maximized (the same document).
 */
export function toggleMaximize(doc: Document, panelId: string): Document {
  const tab = tabWith(doc, panelId);
  if (tab?.layout == null) return doc;
  if (maximizedPanel(tab) === panelId) {
    return updateTab(doc, tab.id, (t) => ({ ...t, maximized: null }));
  }
  if (panelsOf(tab.layout).length < 2) return doc;
  return updateTab(doc, tab.id, (t) => ({ ...t, maximized: panelId, focused: panelId }));
}

/** Panel `panelId` with the user's title (an empty one gives the title back to the program). */
export function renamePanel(doc: Document, panelId: string, title: string): Document {
  const own = title.trim();
  return changePanel(doc, panelId, (p) => ({ ...p, title: own === "" ? null : own }));
}

// N-10: git worktrees. A worktree is a workspace whose `folder` is the worktree's path and whose
// `main` is the ID of its repository's main workspace.

/** The main workspace of worktree workspace `workspace`; `undefined` for a plain one. */
export function mainOf(doc: Document, workspace: Workspace): Workspace | undefined {
  if (workspace.main == null) return undefined;
  const main = doc.workspaces.find((w) => w.id === workspace.main);
  return main === undefined || main.main != null || main.id === workspace.id ? undefined : main;
}

/** The worktree workspaces of main workspace `mainId`, in document order. */
export function worktreesOf(doc: Document, mainId: string): Workspace[] {
  return doc.workspaces.filter((w) => w.id !== mainId && w.main === mainId && mainOf(doc, w));
}

/**
 * `folder` moved from the tree at `from` to the tree at `to` (the same relative path), when it
 * is `from` or inside it; any other folder stays as it is.
 */
export function remapFolder(folder: string, from: string, to: string): string {
  const source = folderKey(from);
  const key = folderKey(folder);
  const target = to.replace(/[\\/]+$/, "");
  if (key === source) return target;
  if (!key.startsWith(`${source}/`)) return folder;
  // The keys keep the text's length, so the rest is cut from the original.
  const rest = folder.replace(/[\\/]+$/, "").slice(source.length + 1);
  const separator = target.includes("\\") || !target.includes("/") ? "\\" : "/";
  return `${target}${separator}${rest.split(/[\\/]+/).join(separator)}`;
}

/**
 * A copy of `tab` (a duplicated tab, a worktree's copied tab): new tab, split and panel IDs,
 * folders moved (`move`), the focused and N-03 maximized panels following their copies.
 */
function copyTab(tab: Tab, move: (folder: string) => string, newId: NewId): Tab {
  const ids = new Map<string, string>();
  const layout = tab.layout == null ? null : copyLayout(tab.layout, move, ids, newId);
  return {
    id: newId(),
    name: tab.name ?? "",
    layout,
    focused: tab.focused == null ? null : (ids.get(tab.focused) ?? null),
    maximized: tab.maximized == null ? null : (ids.get(tab.maximized) ?? null),
  };
}

/**
 * `layout` with fresh split and panel IDs and folders moved (`move`); `ids` maps old → new.
 * N-03: a terminal's folders and agent are copied as below; a content of another kind is kept
 * as it is (the same object), whatever it holds.
 */
function copyLayout(
  layout: Layout,
  move: (folder: string) => string,
  ids: Map<string, string>,
  newId: NewId,
): Layout {
  const id = newId();
  ids.set(layout.id, id);
  if (layout.kind === "split") {
    return {
      ...layout,
      id,
      children: layout.children.map((child) => copyLayout(child, move, ids, newId)),
      ratios: [...layout.ratios],
    };
  }
  return changeTerminal({ ...layout, id }, (terminal) => {
    const cwd = terminal.cwd == null ? null : move(terminal.cwd);
    const agent = terminal.agent;
    return {
      ...terminal,
      cwd,
      // A fresh agent: its own new session (never the main tree's), started in the moved folder.
      agent:
        agent == null
          ? null
          : {
              agent: agent.agent,
              session: agent.session == null ? null : newId(),
              cwd: agent.cwd == null ? cwd : move(agent.cwd),
              running: true,
            },
    };
  });
}

/**
 * N-10: copies of `tabs` for a worktree: new tab, split and panel IDs (the focused and maximized
 * panels follow), each folder inside the tree at `from` moved to the same place in the tree at `to`,
 * and every agent panel a fresh agent (a new session ID, running). Returns the tabs and which
 * copied tab the shown one became.
 */
export function copyTabsInto(
  tabs: readonly Tab[],
  activeTabId: string | null | undefined,
  from: string,
  to: string,
  newId: NewId,
): { readonly tabs: Tab[]; readonly activeTab: string | null } {
  const move = (folder: string) => remapFolder(folder, from, to);
  const copies = tabs.map((tab) => copyTab(tab, move, newId));
  const shown = copies[tabs.findIndex((tab) => tab.id === activeTabId)] ?? copies[0];
  return { tabs: copies, activeTab: shown?.id ?? null };
}

/**
 * N-10: a worktree workspace at `path` (named after `branch`) under main workspace `mainId`,
 * shown: one empty tab, or a copy of the main workspace's tabs when `copyFrom` is the folder
 * of the main's tree (folders in it are moved to the worktree). Placed after the main
 * workspace's other worktrees. A workspace that already has `path` is shown instead. Returns the
 * document and the copied panels' IDs (none when nothing was copied).
 */
export function createWorktreeWorkspace(
  doc: Document,
  mainId: string,
  path: string,
  branch: string,
  copyFrom: string | null,
  newId: NewId,
): { readonly document: Document; readonly panels: readonly string[] } {
  const main = doc.workspaces.find((w) => w.id === mainId);
  if (main === undefined) return { document: doc, panels: [] };
  const known = workspaceForFolder(doc, path);
  if (known !== undefined) return { document: activateWorkspace(doc, known.id), panels: [] };
  const copied =
    copyFrom === null ? undefined : copyTabsInto(main.tabs, main.activeTab, copyFrom, path, newId);
  const tabs = copied === undefined || copied.tabs.length === 0 ? [emptyTab(newId)] : copied.tabs;
  const workspace: Workspace = {
    id: newId(),
    name: branch,
    folder: path,
    tabs,
    activeTab: copied?.activeTab ?? tabs[0]?.id ?? null,
    main: mainId,
  };
  const last = [main, ...worktreesOf(doc, mainId)].at(-1) ?? main;
  const at = doc.workspaces.indexOf(last) + 1;
  const workspaces = [...doc.workspaces.slice(0, at), workspace, ...doc.workspaces.slice(at)];
  return {
    document: { ...doc, workspaces, active: workspace.id },
    panels: copied === undefined ? [] : workspacePanels(workspace).map((p) => p.id),
  };
}

/** Every panel of `workspace`, tab by tab in reading order. */
export function workspacePanels(workspace: Workspace): PanelLeaf[] {
  return workspace.tabs.flatMap((t) => (t.layout == null ? [] : panelsOf(t.layout)));
}
