// The window's content: the title bar, the panels and the right bar.
import { TooltipHost } from "@wolfcmd/ui-kit";
import { useStore } from "zustand";

import type { Actions } from "./actions";
import type { BarRegistry } from "./chrome/bar";
import { CloseDialog } from "./chrome/CloseDialog";
import { RightBar } from "./chrome/RightBar";
import { StateNotice } from "./chrome/StateNotice";
import { TitleBar } from "./chrome/TitleBar";
import { UndoNotice } from "./chrome/UndoNotice";
import type { Geometry } from "./model/layout";
import { TabView } from "./panels/TabView";
import type { SettingsStore } from "./store/settings";
import type { WorkspaceStore } from "./store/workspaces";

export interface AppProps {
  readonly store: WorkspaceStore;
  readonly settings: SettingsStore;
  readonly actions: Actions;
  /** N-06: the right bar's items (Agents; plugins' buttons later). */
  readonly bar: BarRegistry;
  readonly onGeometry: (panels: Geometry["panels"]) => void;
}

export function App({ store, settings, actions, bar, onGeometry }: AppProps) {
  const { document: doc } = useStore(store);
  const look = useStore(settings);
  return (
    <div className="flex h-full flex-col bg-bg-subtle">
      <TitleBar document={doc} actions={actions} settings={look} store={store} />
      <StateNotice />
      <div className="flex min-h-0 flex-1">
        <main className="flex min-w-0 flex-1 pb-(--wc-panel-gap) pl-(--wc-panel-gap)">
          <TabView
            document={doc}
            store={store}
            actions={actions}
            settings={look}
            onGeometry={onGeometry}
          />
        </main>
        <RightBar bar={bar} actions={actions} />
      </div>
      <UndoNotice />
      <CloseDialog />
      <TooltipHost />
    </div>
  );
}
