// What each terminal's program calls itself now (its window title). Kept in memory, not in the
// document: a shell retitles itself on every command.
import type { Document } from "@wolfcmd/bindings";
import { createStore } from "zustand/vanilla";

import { workspacePanels } from "../model/document";

export const titles = createStore<Readonly<Record<string, string>>>(() => ({}));

export function setTitle(panelId: string, title: string): void {
  if (titles.getState()[panelId] === title) return;
  titles.setState({ [panelId]: title });
}

/**
 * Titles of panels that left `doc` (closed, their tab or workspace closed) are dropped. Not on
 * unmount: a view mounted again (a reload) keeps showing its program's title.
 */
export function forgetTitles(doc: Document): void {
  const all = titles.getState();
  const ids = Object.keys(all);
  if (ids.length === 0) return;
  const present = new Set(doc.workspaces.flatMap((w) => workspacePanels(w).map((p) => p.id)));
  if (ids.every((id) => present.has(id))) return;
  titles.setState(Object.fromEntries(Object.entries(all).filter(([id]) => present.has(id))), true);
}
