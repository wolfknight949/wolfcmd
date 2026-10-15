// N-06: what the right bar's Add flyout (+) offers, as a registry of "add entries": each is a
// kind of panel the user can add (today only Terminal), with optional sub-choices (its shells).
// The flyout lists what is registered and knows no entry by name.
//
// The seam for more panel kinds: each panel type (N-03, `panels/types.ts`) offers one entry here
// (`PanelType.add`); its `open` places a panel of that type (`actions.addPanel`). Terminal is the
// built-in type's entry.
import type { MenuSection } from "@wolfcmd/ui-kit";
import { GLYPHS } from "@wolfcmd/ui-kit";

import type { Actions } from "../actions";
import { type Catalog, profileName } from "../store/catalog";
import { createRegistry, type Registered, type Registry } from "./registry";

type Glyph = keyof typeof GLYPHS;

/** A sub-choice of an entry (a shell of the Terminal entry). */
export interface AddChoice {
  readonly id: string;
  readonly label: string;
  readonly icon?: Glyph;
  readonly open: (actions: Actions) => void;
}

export interface AddEntry extends Registered {
  readonly label: string;
  readonly icon: Glyph;
  /** A short note after the label (what it opens by default), from what this computer has. */
  readonly note?: (catalog: Catalog) => string | undefined;
  /** Its sub-choices, from what this computer has (listed under it). */
  readonly choices?: (catalog: Catalog) => readonly AddChoice[];
  /** Adds the panel (in the shown tab: next to the focused panel, or the empty tab's first). */
  readonly open: (actions: Actions) => void;
}

export type AddRegistry = Registry<AddEntry>;

export const createAddRegistry = (): AddRegistry => createRegistry<AddEntry>("add entry");

const isGlyph = (name: string): name is Glyph => name in GLYPHS;

/** N-06: the built-in entry: a plain terminal (no agent), the default shell or a chosen one. */
export const TERMINAL_ENTRY: AddEntry = {
  id: "wolfcmd.terminal",
  order: 0,
  label: "Terminal",
  icon: "terminal",
  note: (catalog) => profileName(catalog.profiles, null),
  choices: (catalog) =>
    catalog.profiles.map((profile) => ({
      id: profile.id,
      label: profile.name,
      icon: isGlyph(profile.icon) ? profile.icon : "terminal",
      open: (actions) => {
        actions.newTerminal(undefined, profile.id);
      },
    })),
  open: (actions) => {
    actions.newTerminal();
  },
};

/**
 * The flyout's sections: one per entry (a line between them): the entry itself, then its
 * choices indented under it.
 */
export function addSections(
  entries: readonly AddEntry[],
  catalog: Catalog,
  actions: Actions,
): MenuSection[] {
  return entries.map((entry, index) => {
    const note = entry.note?.(catalog);
    return {
      ...(index === 0 ? { label: "Add a panel" } : {}),
      items: [
        {
          id: entry.id,
          label: entry.label,
          icon: entry.icon,
          ...(note === undefined ? {} : { hint: note }),
          onSelect: () => {
            entry.open(actions);
          },
        },
        ...(entry.choices?.(catalog) ?? []).map((choice) => ({
          id: `${entry.id}/${choice.id}`,
          label: choice.label,
          inset: true,
          ...(choice.icon === undefined ? {} : { icon: choice.icon }),
          onSelect: () => {
            choice.open(actions);
          },
        })),
      ],
    };
  });
}
