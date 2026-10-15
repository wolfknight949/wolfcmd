// N-03 panel types: what a panel of each kind looks like, as a registry shaped like the chrome's
// (`chrome/registry.ts`). A panel's saved content names its type (`content.kind`); `TabView`
// draws every card through the type registered for that kind (never a switch on the kind), and
// a kind nobody registered (a newer WolfCmd's, a plugin that isn't installed) gets the calm
// placeholder card (`UnknownPanel`), which keeps the panel's content as it is.
//
// A type is its kind, its view, its header (the title and icon rules, drawn by the shared
// `PanelHeader`) and the entry the Add flyout (+) offers for it (`chrome/add-entries.ts`). How to
// add one: docs/guides/panel-types.md.
import type { ComponentType, PointerEvent } from "react";

import type { Actions } from "../actions";
import type { AddEntry, AddRegistry } from "../chrome/add-entries";
import { createRegistry, type Registered, type Registry } from "../chrome/registry";
import type { PanelLeaf } from "../model/layout";
import type { FullSettings } from "../store/settings";

/** N-03: the layout items a panel's own menu may offer. */
export type LayoutAction = "splitRight" | "splitDown" | "maximize";

/** What every panel view gets. Callbacks are one function for every panel (keyed by its ID). */
export interface PanelViewProps {
  readonly panel: PanelLeaf;
  /** The panel's workspace folder and names. */
  readonly folder: string | null;
  readonly workspaceName: string;
  readonly tabName: string;
  /** It has the keyboard (the shown workspace's focused panel). */
  readonly focused: boolean;
  /** Its tab is shown and it isn't parked behind a maximized panel. */
  readonly visible: boolean;
  readonly settings: FullSettings;
  /** N-03: the tab's only panel, and whether it fills its tab. */
  readonly alone: boolean;
  readonly maximized: boolean;
  readonly actions: Actions;
  /**
   * Changes the panel's saved content (the same document when nothing changed, so nothing
   * re-renders or is saved).
   */
  readonly onChange: (panelId: string, change: (panel: PanelLeaf) => PanelLeaf) => void;
  readonly onFocus: (panelId: string) => void;
  readonly onLayout: (panelId: string, action: LayoutAction) => void;
}

/** What every panel header gets (a type's `Header` draws `PanelHeader` with its look). */
export interface PanelHeaderProps {
  readonly panel: PanelLeaf;
  readonly visible: boolean;
  readonly focused: boolean;
  /** The workspace's folder (a header names the panel's own folder only when it differs). */
  readonly folder: string | null;
  readonly alone: boolean;
  readonly maximized: boolean;
  readonly actions: Actions;
  /** A press on the header (not on a button) that may become a drag of the panel. */
  readonly onDragStart: (panelId: string, title: string, event: PointerEvent<HTMLElement>) => void;
}

export interface PanelType extends Registered {
  /** The `kind` its panels' content is saved with (`terminal`; a plugin's: `<plugin id>.<type>`). */
  readonly kind: string;
  /** What it is called ("Terminal"). */
  readonly label: string;
  /** Its panel's body, below the header. Memoized by `TabView`: it re-renders on its own props. */
  readonly View: ComponentType<PanelViewProps>;
  /** Its header: `PanelHeader` with this type's title, icon and color. */
  readonly Header: ComponentType<PanelHeaderProps>;
  /** What the Add flyout (+) offers for it, registered in `chrome/add-entries.ts`. */
  readonly add?: AddEntry;
}

export type PanelTypes = Registry<PanelType>;

export const createPanelTypes = (): PanelTypes => createRegistry<PanelType>("panel type");

/**
 * N-03: each panel type's entry on the Add flyout (+), registered in `entries`: the types
 * registered now and later (a type removed takes its entry along). Returns the stop.
 */
export function offerAddEntries(types: PanelTypes, entries: AddRegistry): () => void {
  const offered = new Map<PanelType, () => void>();
  const follow = () => {
    const now = new Set(types.list());
    for (const [type, remove] of offered) {
      if (now.has(type)) continue;
      remove();
      offered.delete(type);
    }
    for (const type of now) {
      if (type.add !== undefined && !offered.has(type))
        offered.set(type, entries.register(type.add));
    }
  };
  follow();
  const unsubscribe = types.subscribe(follow);
  return () => {
    unsubscribe();
    for (const remove of offered.values()) remove();
    offered.clear();
  };
}

/** The type registered for `kind` (the first in order), if any. */
export function typeFor(types: readonly PanelType[], kind: string): PanelType | undefined {
  return types.find((type) => type.kind === kind);
}
