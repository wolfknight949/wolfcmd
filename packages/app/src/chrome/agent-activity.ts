// N-06: agent activity, wired: the core's working / idle changes go into `store/activity.ts`
// with where the user's eyes are; a finish the user didn't see while the window was behind
// tells the core (the taskbar button flashes, the optional notification shows); showing a tab
// (or bringing the window forward) clears what the user now sees; a clicked notification shows
// its panel. N-06: a finish in a panel the user isn't looking at also glows that panel once
// (`finish-glow.ts`): at once when it is on screen, else when it comes on screen (its tab shown,
// the maximize ended, the window back in front). Events only: nothing polls, nothing runs per
// output chunk.
import type { Document } from "@wolfcmd/bindings";

import type { Actions } from "../actions";
import { agentDone, onAgentActivity, onShowPanel } from "../core/activity";
import { activeTab, activeWorkspace, maximizedPanel, tabName } from "../model/document";
import { hasPanel, panelsOf } from "../model/layout";
import { agentOf } from "../model/panels";
import {
  activity,
  agentIdle,
  agentWorking,
  forgetActivity,
  seen,
  type Sight,
} from "../store/activity";
import { catalog } from "../store/catalog";
import type { WorkspaceStore } from "../store/workspaces";
import type { FinishGlow } from "./finish-glow";

/** The workspace and tab holding `panelId`. */
function placeOf(doc: Document, panelId: string) {
  for (const workspace of doc.workspaces) {
    for (const tab of workspace.tabs) {
      if (tab.layout != null && hasPanel(tab.layout, panelId)) return { workspace, tab };
    }
  }
  return undefined;
}

/**
 * The panels on screen: the shown tab's, or only its maximized one (N-03: the others are parked
 * out of sight, like a hidden tab's).
 */
function onScreen(doc: Document): readonly string[] {
  const tab = activeTab(activeWorkspace(doc));
  if (tab?.layout == null) return [];
  const maximized = maximizedPanel(tab);
  return maximized === undefined ? panelsOf(tab.layout).map((p) => p.id) : [maximized];
}

/** Where the user's eyes are for `panelId` (`front`: the window is in front). */
export function sightOf(doc: Document, panelId: string, front: boolean): Sight {
  if (!front || !onScreen(doc).includes(panelId)) return "away";
  return activeTab(activeWorkspace(doc))?.focused === panelId ? "looking" : "tab";
}

/** What the user sees now: the panels on screen and the focused one, if the window is in front. */
function look(doc: Document, front: boolean): void {
  if (!front) return;
  seen(onScreen(doc), activeTab(activeWorkspace(doc))?.focused ?? undefined);
}

/** The installed wiring's removal (installing again replaces it: a hot reload). */
let installed: (() => void) | undefined;

/**
 * Wires agent activity up (and, with `glow`, the finish reward); returns its removal. Installing
 * again first removes the last one.
 */
export function installAgentActivity(
  store: WorkspaceStore,
  actions: Actions,
  win: Window = window,
  glow?: FinishGlow,
): () => void {
  installed?.();
  const front = () => win.document.hasFocus();
  const doc = () => store.getState().document;

  // N-06: the glow plays only for what the user can see: the window in front and not hidden.
  const glowSight = (panelId: string) =>
    sightOf(doc(), panelId, front() && win.document.visibilityState !== "hidden");

  const stopActivity = onAgentActivity((panelId, working) => {
    if (working) {
      agentWorking(panelId);
      return;
    }
    const wasWorking = activity.getState()[panelId]?.state === "working";
    const place = placeOf(doc(), panelId);
    const panel =
      place?.tab.layout == null
        ? undefined
        : panelsOf(place.tab.layout).find((p) => p.id === panelId);
    const agentId = panel === undefined ? undefined : agentOf(panel)?.agent;
    const agent = catalog.getState().agents.find((a) => a.id === agentId);
    const color = agent === undefined ? undefined : `var(--wc-workspace-${String(agent.color)})`;
    // N-06: the finish keeps the agent's color: its tab pill glows in it.
    const unseen = agentIdle(panelId, sightOf(doc(), panelId, front()), color);
    if (!wasWorking) return;
    // N-06: the panel's own block glows once in the agent's color (never while the user looks).
    glow?.finished(panelId, color, glowSight(panelId));
    if (!unseen || front() || place === undefined || panel === undefined) return;
    agentDone(panelId, agent?.name ?? "The agent", tabName(place.workspace, place.tab));
  });

  const stopShow = onShowPanel((panelId) => {
    const place = placeOf(doc(), panelId);
    if (place === undefined) return;
    actions.activateTab(place.tab.id);
    actions.focusPanel(panelId);
  });

  // Showing a tab, focusing a panel, bringing the window forward: the user sees it now. N-06: a
  // panel's waiting glow plays once it is on screen.
  const update = () => {
    const now = doc();
    const present = (id: string) => placeOf(now, id) !== undefined;
    if (glow !== undefined) {
      glow.forget(present);
      glow.look(glowSight);
    }
    if (Object.keys(activity.getState()).length === 0) return;
    forgetActivity(present);
    look(now, front());
  };
  const unsubscribe = store.subscribe(update);
  win.addEventListener("focus", update);
  win.document.addEventListener("visibilitychange", update);
  let removed = false;
  const uninstall = () => {
    if (removed) return;
    removed = true;
    if (installed === uninstall) installed = undefined;
    stopActivity();
    stopShow();
    unsubscribe();
    win.removeEventListener("focus", update);
    win.document.removeEventListener("visibilitychange", update);
  };
  installed = uninstall;
  return uninstall;
}
