// Everything the user can do, in one place: the title bar, panel headers and keys call these.
// Each is a pure document change (`model/`) applied by the store, which saves it. N-11: layout
// and workspace changes are undoable steps (named for the Undo and Redo tooltips); every close
// (a panel, tabs, a workspace, the quit) goes through `guarded`, which asks first while an
// agent or a command still runs there.
import type { AgentInfo, Panel, PanelContent, Tab } from "@wolfcmd/bindings";

import { askToClose, type CloseAnswer } from "./chrome/close-question";
import { noticeText, showUndoNotice } from "./chrome/undo-notice";
import { openLink, pickFolder } from "./core/app";
import { addWorktree, readRepository, removeWorktree } from "./core/git";
import { quitApp } from "./core/window";
import {
  type Closing,
  type CloseQuestion,
  closeQuestion,
  runningIn,
  type RunningProbe,
} from "./model/close-rules";
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
  maximizedPanel,
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
import type { Step } from "./model/history";
import {
  type Arrow,
  hasPanel,
  neighbor,
  type PanelLeaf,
  panelsOf,
  type Rect,
  type Side,
} from "./model/layout";
import { agentOf, panelFolder, terminalPanel } from "./model/panels";
import { flipFolder } from "./model/remote-control";
import { working } from "./store/activity";
import { freshAgents } from "./store/agent-starts";
import { catalog } from "./store/catalog";
import { commandRuns } from "./store/commands";
import { changed, type SettingsStore, stepFontSize } from "./store/settings";
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
  /** N-11: undoes the newest layout or workspace change (a notice when it is off screen). */
  undo(): void;
  /** N-11: does the newest undone change again. */
  redo(): void;
  /**
   * N-01: quits WolfCmd for real (Ctrl+Q, N-11 the tray's Quit): the core saves and ends every
   * terminal. N-11: asks first while an agent runs.
   */
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

/** N-11: how a close learns what runs and asks the user (the dialog; tests answer themselves). */
export interface CloseAsking extends RunningProbe {
  readonly ask: (question: CloseQuestion) => Promise<CloseAnswer>;
  /** An agent's name by its registry ID. */
  readonly agentName: (agentId: string) => string;
}

const APP_ASKING: CloseAsking = {
  working,
  commandRuns,
  ask: askToClose,
  agentName: (id) => catalog.getState().agents.find((a) => a.id === id)?.name ?? id,
};

export function createActions(
  store: WorkspaceStore,
  settings: SettingsStore,
  asking: CloseAsking = APP_ASKING,
): Actions {
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
  /** N-11: a new panel splits the shown tab's focused one, or fills the empty tab. */
  const placeStep = (side: Side, label?: string): Step => ({
    label: label ?? (shownTab()?.layout == null ? "new terminal" : `split ${side}`),
  });
  const place = (panel: Panel, side: Side = "right", label?: string) => {
    const step = placeStep(side, label);
    store.apply((d) => openPanel(d, panel, side, newId), step);
  };
  const tabsWhere = (keep: (index: number, at: number) => boolean, tabId: string) => {
    const owner = doc().workspaces.find((w) => w.tabs.some((t) => t.id === tabId));
    if (owner === undefined) return [];
    const at = owner.tabs.findIndex((t) => t.id === tabId);
    return owner.tabs.filter((_, index) => !keep(index, at));
  };
  const panelsIn = (tabs: readonly Tab[]) =>
    tabs.flatMap((t) => (t.layout == null ? [] : panelsOf(t.layout)));
  /**
   * N-11: runs `close` at once when nothing in `panels` runs (or the user turned the question
   * off); otherwise asks first and closes only on Close. "Don't ask again" turns it off.
   */
  const guarded = (
    panels: readonly PanelLeaf[],
    closing: Closing,
    close: () => void,
    count?: number,
  ) => {
    const question = settings.getState().window.confirm_close
      ? closeQuestion(closing, runningIn(panels, asking), asking.agentName, count)
      : undefined;
    if (question === undefined) {
      close();
      return;
    }
    void asking.ask(question).then((answer) => {
      if (!answer.close) return;
      if (answer.dontAsk) settings.apply((s) => changed(s, "window", { confirm_close: false }));
      close();
    });
  };
  const allPanels = () => doc().workspaces.flatMap(workspacePanels);

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
      place(
        terminalPanel(id, { cwd, agent: { agent: agent.id, session, cwd, running: true } }),
        "right",
        `open ${agent.name}`,
      );
    },
    closePanel(panelId) {
      const panel = allPanels().find((p) => p.id === panelId);
      if (panel === undefined) return;
      guarded([panel], "panel", () => {
        store.apply((d) => closePanel(d, panelId), { label: "close panel" });
      });
    },
    focusPanel(panelId) {
      store.apply((d) => focusPanel(d, panelId));
    },
    splitPanel(panelId, side) {
      this.focusPanel(panelId);
      this.newTerminal(side);
    },
    toggleMaximize(panelId) {
      const tab = doc()
        .workspaces.flatMap((w) => w.tabs)
        .find((t) => t.layout != null && hasPanel(t.layout, panelId));
      const label = maximizedPanel(tab) === panelId ? "restore tiles" : "maximize panel";
      store.apply((d) => toggleMaximize(d, panelId), { label });
    },
    renamePanel(panelId, name) {
      store.apply((d) => renamePanel(d, panelId, name), {
        label: "rename panel",
        group: `rename:${panelId}`,
      });
    },
    dropPanel(panelId, targetId, zone) {
      const label = zone === "center" ? "swap panels" : "move panel";
      store.apply((d) => dropPanel(d, panelId, targetId, zone, newId), { label });
    },
    focusNeighbor(arrow, panels) {
      const tab = shownTab();
      if (tab?.layout == null || tab.focused == null || !hasPanel(tab.layout, tab.focused)) return;
      const target = neighbor(panels, tab.focused, arrow);
      if (target !== undefined) this.focusPanel(target);
    },
    newTab() {
      store.apply((d) => addTab(d, newId), { label: "new tab" });
    },
    closeTab(tabId) {
      const tabs = tabsWhere((index, at) => index !== at, tabId);
      guarded(panelsIn(tabs), "tab", () => {
        store.apply((d) => closeTab(d, tabId, newId), { label: "close tab" });
      });
    },
    duplicateTab(tabId) {
      let copied: readonly string[] = [];
      store.apply(
        (d) => {
          const { document, panels } = duplicateTab(d, tabId, newId);
          copied = panels;
          return document;
        },
        { label: "duplicate tab" },
      );
      // N-06: copied agent panels start new sessions of their own.
      markFresh(copied);
    },
    closeOtherTabs(tabId) {
      const tabs = tabsWhere((index, at) => index === at, tabId);
      guarded(
        panelsIn(tabs),
        tabs.length === 1 ? "tab" : "tabs",
        () => {
          store.apply((d) => closeOtherTabs(d, tabId), { label: "close other tabs" });
        },
        tabs.length,
      );
    },
    closeTabsToRight(tabId) {
      const tabs = tabsWhere((index, at) => index <= at, tabId);
      guarded(
        panelsIn(tabs),
        tabs.length === 1 ? "tab" : "tabs",
        () => {
          store.apply((d) => closeTabsToRight(d, tabId), { label: "close tabs to the right" });
        },
        tabs.length,
      );
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
      store.apply((d) => moveTab(d, tabId, to), { label: "move tab" });
    },
    renameTab(tabId, name) {
      store.apply((d) => updateTab(d, tabId, (t) => ({ ...t, name: name.trim() })), {
        label: "rename tab",
        group: `rename:${tabId}`,
      });
    },
    newWorkspace() {
      store.apply((d) => createWorkspace(d, null, newId), { label: "new workspace" });
    },
    async openFolder() {
      const folder = await pickFolder(
        "Open a folder as a workspace",
        activeWorkspace(doc())?.folder ?? undefined,
      );
      if (folder === null) return;
      const known = workspaceForFolder(doc(), folder);
      if (known !== undefined) store.apply((d) => activateWorkspace(d, known.id));
      else store.apply((d) => createWorkspace(d, folder, newId), { label: "open folder" });
    },
    activateWorkspace(id) {
      store.apply((d) => activateWorkspace(d, id));
    },
    closeWorkspace(id) {
      const workspace = doc().workspaces.find((w) => w.id === id);
      if (workspace === undefined) return;
      guarded(workspacePanels(workspace), "workspace", () => {
        store.apply((d) => closeWorkspace(d, id, newId), { label: "close workspace" });
      });
    },
    renameWorkspace(id, name) {
      store.apply((d) => updateWorkspace(d, id, (w) => ({ ...w, name: name.trim() })), {
        label: "rename workspace",
        group: `rename:${id}`,
      });
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
    undo() {
      const moved = store.undo();
      if (moved?.offscreen === true) showUndoNotice(noticeText(moved.label, true));
    },
    redo() {
      const moved = store.redo();
      if (moved?.offscreen === true) showUndoNotice(noticeText(moved.label, false));
    },
    quit() {
      guarded(allPanels(), "quit", () => {
        // The settings and the document are saved first (the core flushes what it has).
        void settings.saved().then(quitApp);
      });
    },
    async newWorktree(mainId, request) {
      const folder = doc().workspaces.find((w) => w.id === mainId)?.folder;
      if (folder == null) return;
      const path = await addWorktree(folder, request.branch, request.newBranch, request.path);
      let copied: readonly string[] = [];
      // N-11: undo closes the workspace only; the git worktree stays (the menu lists it).
      store.apply(
        (d) => {
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
        },
        { label: "new worktree" },
      );
      // N-06: copied agent panels start new sessions of their own (only the ones just copied:
      // the main workspace may have closed while git worked, and then nothing was).
      markFresh(copied);
      void readRepository(folder).catch(() => undefined);
    },
    openWorktree(mainId, path, branch) {
      store.apply((d) => createWorktreeWorkspace(d, mainId, path, branch, null, newId).document, {
        label: "open worktree",
      });
    },
    async removeWorktree(id, force) {
      const workspace = doc().workspaces.find((w) => w.id === id);
      const main = workspace === undefined ? undefined : mainOf(doc(), workspace);
      if (workspace?.folder == null || main === undefined) return;
      // N-11: closed panels waiting for an undo may stand in the folder too: they end with it,
      // and nothing before the removal can be undone.
      const panels = [...workspacePanels(workspace).map((p) => p.id), ...store.undoable()];
      await removeWorktree(workspace.folder, force, panels);
      store.forget();
      store.apply((d) =>
        closeWorkspace(d.active === id ? activateWorkspace(d, main.id) : d, id, newId),
      );
      if (main.folder != null) void readRepository(main.folder).catch(() => undefined);
    },
  };
}
