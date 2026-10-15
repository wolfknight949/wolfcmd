// N-06: the + (Add) button at the top of the right bar and its flyout: the registered add
// entries (`add-entries.ts`), each with its choices. The opaque ui-kit flyout, anchored to the
// button on its left; arrows, type-ahead, Enter and Esc come with it.
import { Menu } from "@wolfcmd/ui-kit";
import { useRef, useSyncExternalStore } from "react";
import { useStore } from "zustand";

import { catalog } from "../store/catalog";
import { addSections, type AddRegistry } from "./add-entries";
import type { BarItem, BarItemProps } from "./bar";
import { focusShownTerminal } from "./focus";
import { BarButton } from "./RightBar";

/** The right bar's Add item for `entries` (first in the bar). */
export function addBarItem(entries: AddRegistry): BarItem {
  function AddBarButton({ actions }: BarItemProps) {
    const list = useSyncExternalStore(entries.subscribe, entries.list);
    const known = useStore(catalog);
    /** An entry was chosen: its new panel takes the keyboard when the flyout has closed. */
    const chosen = useRef(false);
    const sections = addSections(list, known, actions).map((section) => ({
      ...section,
      items: section.items.map((item) => ({
        ...item,
        onSelect: () => {
          chosen.current = true;
          item.onSelect();
        },
      })),
    }));
    return (
      <Menu
        onOpenChange={(open) => {
          if (open) chosen.current = false;
        }}
        onCloseFocus={() => {
          const opened = chosen.current;
          chosen.current = false;
          return opened && focusShownTerminal();
        }}
        trigger={<BarButton icon="add" label="Add" />}
        side="left"
        align="start"
        sections={sections}
      />
    );
  }
  return { id: "wolfcmd.add", order: 0, Component: AddBarButton };
}
