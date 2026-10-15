// Everything the user can do, in one place: the title bar, panel headers and keys call these.
// Each is a pure document change (`model/`) applied by the store, which saves it.
import type { AgentInfo, Panel, PanelContent } from "@wolfcmd/bindings";

import { openLink, pickFolder } from "./core/app";
import { addWorktree, readRepository, removeWorktree } from "./core/git";
import { quitApp } from "./core/window";
import {
  activateTab,
  activateTabNumber,
  activateWorkspace,
  activeTab,
  activeWorkspace,
  addTab,
  closeOtherTabs,
  closePanel,
  closeTab,
  closeTabsToRight,
  closeWorkspace,
  createWorkspace,
  createWorktreeWorkspace,
  cycleTab,
  dropPanel,
  duplicateTab,
  focusPanel,
  mainOf,
  moveTab,
  openPanel,
  renamePanel,
  toggleMaximize,
  updateTab,
  updateWorkspace,
  workspaceForFolder,
  workspacePanels,
} from "./model/document";
import type { Zone } from "./model/drop";
import { type Arrow, hasPanel, neighbor, panelsOf, type Rect, type Side } from "./model/layout";
import { agentOf, panelFolder, terminalPanel } from "./model/panels";
import { flipFolder } from "./model/remote-control";
import { freshAgents } from "./store/agent-starts";
import { type SettingsStore, stepFontSize } from "./store/settings";
import type { WorkspaceStore } from "./store/workspaces";

const newId = () => crypto.randomUUID();

export interface Actions {
  /** A terminal next to the focused panel (`side`, default right) or in the empty tab; N-06
   *  `profile`: that shell (default: the default shell). */
  newTerminal(side?: Side, profile?: string): void;
  /**
   * N-03: a panel of any registered type (its content: `kind` and the type's own fields) next to
   * the focused panel (`side`, default right) or as the empty tab's first panel.
   */
  addPanel(content: PanelContent, side?: Side): void;
  openAgent(agent: AgentInfo): void;
  closePanel(panelId: string): void;
  focusPanel(panelId: string): void;
  /** N-03: a new terminal on `side` of panel `panelId` (it gets the focus first). */
  splitPanel(panelId: string, side: Side): void;
  /** N-03: panel `panelId` fills its tab, or its tab shows the tiles again. */
  toggleMaximize(panelId: string): void;
  /** N-03: the panel's own title (empty: the program's again). */
  renamePanel(panelId: string, name: string): void;
  /** N-03: a panel dragged onto `zone` of another panel of its tab (split there, or swap). */
  dropPanel(panelId: string, targetId: string, zone: Zone): void;
  focusNeighbor(arrow: Arrow, panels: ReadonlyMap<string, Rect>): void;
  newTab(): void;
  closeTab(tabId: string): void;
  /** N-03: a copy of the tab after it (fresh shells, fresh agents), shown. */
  duplicateTab(tabId: string): void;
  /** N-03: every other tab of its workspace closes. */
  closeOtherTabs(tabId: string): void;
  /** N-03: the tabs after it close. */
  closeTabsToRight(tabId: string): void;
  activateTab(tabId: string): void;
  activateTabNumber(n: number): void;
  cycleTab(step: 1 | -1): void;
  moveTab(tabId: string, to: number): void;
  renameTab(tabId: string, name: string): void;
  newWorkspace(): void;
  openFolder(): Promise<void>;
  activateWorkspace(id: string): void;
  closeWorkspace(id: string): void;
  renameWorkspace(id: string, name: string): void;
  toggleRemoteControl(folder: string): void;
  /** N-03: shows a workspace's folder in the file manager (the core opens it). */
  revealFolder(folder: string): void;
  fontSize(step: 1 | -1): void;
  /** N-01: quits WolfCmd for real (Ctrl+Q): the core saves and ends every terminal. */
  quit(): void;
  /** N-10: a new git worktree of main workspace `mainId`'s repository, shown in its own workspace. */
  newWorktree(mainId: string, request: WorktreeRequest): Promise<void>;
  /** N-10: shows the workspace of a worktree made outside WolfCmd (made on first use). */
  openWorktree(mainId: string, path: string, branch: string): void;
  /** N-10: removes worktree workspace `id`'s worktree (its terminals end first) and closes it. */
  removeWorktree(id: string, force: boolean): Promise<void>;
}

/** N-10: what the New worktree dialog asks for. */
export interface WorktreeRequest {
  readonly branch: string;
  /** A new branch from the main tree's HEAD (else an existing branch). */
  readonly newBranch: boolean;
  readonly path: string;
  /** The main workspace's tree, to copy its tabs from (folders in it are moved); `null`: empty. */
  readonly copyFrom: string | null;
}

export function createActions(store: WorkspaceStore, settings: SettingsStore): Actions {
  const doc = () => store.getState().document;
  const shownTab = () => activeTab(activeWorkspace(doc()));
  /** A new terminal starts in the focused terminal's folder, else the workspace's. */
  const startFolder = () => {
    const tab = shownTab();
    const focused =
      tab?.layout == null || tab.focused == null
        ? undefined
        : panelsOf(tab.layout).find((p) => p.id === tab.focused);
    return (
      (focused === undefined ? null : panelFolder(focused)) ??
      activeWorkspace(doc())?.folder ??
      null
    );
  };
  /** N-06: the agent panels among `panelIds` (just copied) start new sessions of their own. */
  const markFresh = (panelIds: readonly string[]) => {
    const ids = new Set(panelIds);
    for (const workspace of doc().workspaces) {
      for (const panel of workspacePanels(workspace)) {
        if (ids.has(panel.id) && agentOf(panel) !== undefined) freshAgents.add(panel.id);
      }
    }
  };
  const place = (panel: Panel, side: Side = "right") => {
    store.apply((d) => openPanel(d, panel, side, newId));
  };

  return {
    newTerminal(side, profile) {
      place(
        terminalPanel(newId(), {
          cwd: startFolder(),
          ...(profile === undefined ? {} : { profile }),
        }),
        side,
      );
    },
    addPanel(content, side) {
      place({ id: newId(), content }, side);
    },
    openAgent(agent) {
      const id = newId();
      freshAgents.add(id);
      const session = agent.takesSessionId ? crypto.randomUUID() : null;
      const cwd = startFolder();
      // N-06: the folder is corrected to where the shell really is when the agent starts.
      place(terminalPanel(id, { cwd, agent: { agent: agent.id, session, cwd, running: true } }));
    },
    closePanel(panelId) {
      store.apply((d) => closePanel(d, panelId));
    },
    focusPanel(panelId) {
      store.apply((d) => focusPanel(d, panelId));
    },
    splitPanel(panelId, side) {
      this.focusPanel(panelId);
      this.newTerminal(side);
    },
    toggleMaximize(panelId) {
      store.apply((d) => toggleMaximize(d, panelId));
    },
    renamePanel(panelId, name) {
      store.apply((d) => renamePanel(d, panelId, name));
    },
    dropPanel(panelId, targetId, zone) {
      store.apply((d) => dropPanel(d, panelId, targetId, zone, newId));
    },
    focusNeighbor(arrow, panels) {
      const tab = shownTab();
      if (tab?.layout == null || tab.focused == null || !hasPanel(tab.layout, tab.focused)) return;
      const target = neighbor(panels, tab.focused, arrow);
      if (target !== undefined) this.focusPanel(target);
    },
    newTab() {
      store.apply((d) => addTab(d, newId));
    },
    closeTab(tabId) {
      store.apply((d) => closeTab(d, tabId, newId));
    },
    duplicateTab(tabId) {
      let copied: readonly string[] = [];
      store.apply((d) => {
        const { document, panels } = duplicateTab(d, tabId, newId);
        copied = panels;
        return document;
      });
      // N-06: copied agent panels start new sessions of their own.
      markFresh(copied);
    },
    closeOtherTabs(tabId) {
      store.apply((d) => closeOtherTabs(d, tabId));
    },
    closeTabsToRight(tabId) {
      store.apply((d) => closeTabsToRight(d, tabId));
    },
    activateTab(tabId) {
      store.apply((d) => activateTab(d, tabId));
    },
    activateTabNumber(n) {
      store.apply((d) => activateTabNumber(d, n));
    },
    cycleTab(step) {
      store.apply((d) => cycleTab(d, step));
    },
    moveTab(tabId, to) {
      store.apply((d) => moveTab(d, tabId, to));
    },
    renameTab(tabId, name) {
      store.apply((d) => updateTab(d, tabId, (t) => ({ ...t, name: name.trim() })));
    },
    newWorkspace() {
      store.apply((d) => createWorkspace(d, null, newId));
    },
    async openFolder() {
      const folder = await pickFolder(
        "Open a folder as a workspace",
        activeWorkspace(doc())?.folder ?? undefined,
      );
      if (folder === null) return;
      const known = workspaceForFolder(doc(), folder);
      store.apply((d) =>
        known === undefined ? createWorkspace(d, folder, newId) : activateWorkspace(d, known.id),
      );
    },
    activateWorkspace(id) {
      store.apply((d) => activateWorkspace(d, id));
    },
    closeWorkspace(id) {
      store.apply((d) => closeWorkspace(d, id, newId));
    },
    renameWorkspace(id, name) {
      store.apply((d) => updateWorkspace(d, id, (w) => ({ ...w, name: name.trim() })));
    },
    toggleRemoteControl(folder) {
      settings.apply((s) => ({
        ...s,
        agents: { ...s.agents, remote_control_folders: flipFolder(s.agents, folder) },
      }));
    },
    revealFolder(folder) {
      // A folder opens in the file manager (`open.rs`); nothing is run.
      openLink(folder);
    },
    fontSize(step) {
      settings.apply((s) => stepFontSize(s, step));
    },
    quit() {
      // The settings and the document are saved first (the core flushes what it has).
      void settings.saved().then(quitApp);
    },
    async newWorktree(mainId, request) {
      const folder = doc().workspaces.find((w) => w.id === mainId)?.folder;
      if (folder == null) return;
      const path = await addWorktree(folder, request.branch, request.newBranch, request.path);
      let copied: readonly string[] = [];
      store.apply((d) => {
        const made = createWorktreeWorkspace(
          d,
          mainId,
          path,
          request.branch.trim(),
          request.copyFrom,
          newId,
        );
        copied = made.panels;
        return made.document;
      });
      // N-06: copied agent panels start new sessions of their own (only the ones just copied:
      // the main workspace may have closed while git worked, and then nothing was).
      markFresh(copied);
      void readRepository(folder).catch(() => undefined);
    },
    openWorktree(mainId, path, branch) {
      store.apply((d) => createWorktreeWorkspace(d, mainId, path, branch, null, newId).document);
    },
    async removeWorktree(id, force) {
      const workspace = doc().workspaces.find((w) => w.id === id);
      const main = workspace === undefined ? undefined : mainOf(doc(), workspace);
      if (workspace?.folder == null || main === undefined) return;
      const panels = workspacePanels(workspace).map((p) => p.id);
      await removeWorktree(workspace.folder, force, panels);
      store.apply((d) =>
        closeWorkspace(d.active === id ? activateWorkspace(d, main.id) : d, id, newId),
      );
      if (main.folder != null) void readRepository(main.folder).catch(() => undefined);
    },
  };
}
