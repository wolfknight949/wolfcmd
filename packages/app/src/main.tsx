// The start: the saved workspaces and settings first, then the first frame, then the window
// shows (it is created hidden, so it never shows empty).
import "./styles.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { createActions } from "./actions";
import { App } from "./App";
import { createAddRegistry } from "./chrome/add-entries";
import { addBarItem } from "./chrome/AddMenu";
import { installAgentActivity } from "./chrome/agent-activity";
import { AGENTS_BAR_ITEM } from "./chrome/AgentsMenu";
import { createBarRegistry } from "./chrome/bar";
import { createFinishGlow } from "./chrome/finish-glow";
import { installDensity } from "./chrome/density";
import { settingsBarItem } from "./chrome/SettingsButton";
import { installTheme } from "./chrome/theme";
import { installTrayHint } from "./chrome/tray-hint";
import { installWindowDrag } from "./chrome/window-drag";
import { agentList } from "./core/agents";
import { answerWatchdog, followWindowBackground, windowReady } from "./core/app";
import { listProfiles } from "./core/profiles";
import { loadSettings, loadState, saveSettings, saveState } from "./core/state";
import {
  onQuitRequested,
  onWindowHidden,
  setWindowTheme,
  showSystemMenu,
  startWindowDrag,
  toggleMaximizeWindow,
} from "./core/window";
import { installKeys } from "./keys";
import { activeTab, activeWorkspace, emptyDocument } from "./model/document";
import type { Geometry } from "./model/layout";
import { catalog } from "./store/catalog";
import { complete, createSettingsStore, type FullSettings } from "./store/settings";
import { panelTypes } from "./panels/builtin-types";
import { installFileDrops } from "./panels/file-drops";
import { offerAddEntries } from "./panels/types";
import { forgetTitles } from "./store/titles";
import { createWorkspaceStore } from "./store/workspaces";

answerWatchdog();
const [loaded, savedSettings] = await Promise.all([loadState(), loadSettings()]);
const initial =
  loaded.document.workspaces.length > 0
    ? loaded.document
    : emptyDocument(() => crypto.randomUUID());
const store = createWorkspaceStore({ document: initial, readOnly: loaded.readOnly }, saveState);
// N-07: saves run one at a time (the store waits for each).
const settings = createSettingsStore(complete(savedSettings), saveSettings);
const actions = createActions(store, settings);

// N-03 / N-06: the shells and agents this computer has (panel names, the Agents menu).
void Promise.all([
  listProfiles().catch((error: unknown) => {
    console.warn("could not list the shell profiles", error);
    return [];
  }),
  agentList().catch((error: unknown) => {
    console.warn("could not list the agents", error);
    return { agents: [], problems: [] };
  }),
]).then(([profiles, { agents, problems }]) => {
  catalog.setState({ profiles, agents, problems });
});

// N-06: the right bar's items (Add on top, then Agents; N-07 Settings at its foot) and what Add
// offers: N-03 each panel type's entry (the terminal's today); plugins will register the same way.
const addEntries = createAddRegistry();
offerAddEntries(panelTypes, addEntries);
const bar = createBarRegistry();
bar.register(addBarItem(addEntries));
bar.register(AGENTS_BAR_ITEM);
// N-07: Settings at the bar's foot.
bar.register(settingsBarItem(settings));

// N-01: slimmer chrome in a small window.
installDensity(window, document.documentElement);

// N-01: the theme setting (Dark Modern by default, Light, or Auto: the system's) is the native
// window's theme (its frame and system menu) and `data-theme` on <html>, which the tokens follow.
// Told only when the theme changes (not on every other setting: each font size step).
const applyTheme = (look: FullSettings) => {
  const theme = look.appearance.theme;
  setWindowTheme(theme === "auto" ? null : theme);
};
applyTheme(settings.getState());
settings.subscribe((now, before) => {
  if (now.appearance.theme !== before.appearance.theme) applyTheme(now);
});
// The tokens follow `data-theme` (the web view's own color scheme stays the system's).
installTheme(
  document.documentElement,
  window.matchMedia("(prefers-color-scheme: dark)"),
  () => settings.getState().appearance.theme,
  (listener) => settings.subscribe(listener),
);
// N-03: the native window and web view behind the page take its background (no flash on resize).
followWindowBackground();

let panels: Geometry["panels"] = new Map();
installKeys(window, {
  actions,
  focusedPanel: () => activeTab(activeWorkspace(store.getState().document))?.focused ?? undefined,
  shownTab: () => activeTab(activeWorkspace(store.getState().document))?.id,
  focusNeighbor: (arrow) => {
    actions.focusNeighbor(arrow, panels);
  },
});
installWindowDrag(document, {
  startDragging: startWindowDrag,
  toggleMaximize: toggleMaximizeWindow,
  systemMenu: showSystemMenu,
});
// N-02: files dropped on a terminal insert their paths at its prompt.
installFileDrops();
// N-06: agents working and finished (the core's events), and what the user has seen; an unseen
// finish makes that agent's panel glow once, when the user can see it (`appearance.finish_glow`,
// never under reduced motion).
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const finishGlow = createFinishGlow({
  allowed: () => settings.getState().appearance.finish_glow && !reduceMotion.matches,
});
installAgentActivity(store, actions, window, finishGlow);
// N-11: the tray's Quit while an agent runs asks here, as Ctrl+Q does.
onQuitRequested(() => {
  actions.quit();
});
// N-01: the first time closing the window hides it to the tray, one calm hint for its return.
installTrayHint(settings, onWindowHidden);
// The live titles of panels that left the document go too.
store.subscribe((now, before) => {
  if (now.document !== before.document) forgetTitles(now.document);
});

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root");
createRoot(root).render(
  <StrictMode>
    <App
      store={store}
      settings={settings}
      actions={actions}
      bar={bar}
      onGeometry={(next) => {
        panels = next;
      }}
    />
  </StrictMode>,
);
// Two frames: the first one is painted.
requestAnimationFrame(() => {
  requestAnimationFrame(windowReady);
});
