// N-03: the panel-type registry: the terminal is built in and offers + its entry; a later type
// joins the same way; a kind nobody registered falls through to the placeholder.
import { describe, expect, it } from "vitest";

import { createAddRegistry, TERMINAL_ENTRY } from "../chrome/add-entries";
import { panelTypes } from "./builtin-types";
import { TERMINAL_TYPE } from "./TerminalType";
import { createPanelTypes, offerAddEntries, type PanelType, typeFor } from "./types";
import { unknownPanelText } from "./UnknownPanel";

describe("N-03 panel types", () => {
  it("n03_types_terminal: the built-in registry has the terminal, with the Terminal add entry", () => {
    expect(typeFor(panelTypes.list(), "terminal")).toBe(TERMINAL_TYPE);
    expect(TERMINAL_TYPE.add).toBe(TERMINAL_ENTRY);
    expect(typeFor(panelTypes.list(), "acme.board")).toBeUndefined();
  });

  it("n03_types_register: a later type is found by its kind, and leaves when removed", () => {
    const types = createPanelTypes();
    types.register(TERMINAL_TYPE);
    const board: PanelType = { ...TERMINAL_TYPE, id: "acme.board", kind: "acme.board", order: 5 };
    const remove = types.register(board);
    expect(typeFor(types.list(), "acme.board")).toBe(board);
    expect(() => types.register(board)).toThrow(/already registered/);
    remove();
    expect(typeFor(types.list(), "acme.board")).toBeUndefined();
  });

  it("n03_types_add_entries: + offers each registered type's entry, later ones too", () => {
    const types = createPanelTypes();
    types.register(TERMINAL_TYPE);
    const entries = createAddRegistry();
    const stop = offerAddEntries(types, entries);
    expect(entries.list()).toEqual([TERMINAL_ENTRY]);
    const boardEntry = { ...TERMINAL_ENTRY, id: "acme.board", label: "Board", order: 5 };
    const board: PanelType = {
      ...TERMINAL_TYPE,
      id: "acme.board",
      kind: "acme.board",
      order: 5,
      add: boardEntry,
    };
    const remove = types.register(board);
    expect(entries.list()).toEqual([TERMINAL_ENTRY, boardEntry]);
    // A type without an entry offers nothing; a removed type takes its entry along.
    const { add: _none, ...plain } = TERMINAL_TYPE;
    types.register({ ...plain, id: "acme.plain", kind: "acme.plain" });
    remove();
    expect(entries.list()).toEqual([TERMINAL_ENTRY]);
    stop();
    expect(entries.list()).toEqual([]);
  });

  it("n03_types_placeholder: what a card of an unknown kind says", () => {
    expect(unknownPanelText("acme.board")).toBe("This panel needs the plugin “acme”.");
    expect(unknownPanelText("browser")).toBe("This panel needs a newer WolfCmd.");
  });
});
