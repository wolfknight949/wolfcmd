import { describe, expect, it, vi } from "vitest";

import type { Actions } from "../actions";
import type { Catalog } from "../store/catalog";
import { type AddEntry, addSections, createAddRegistry, TERMINAL_ENTRY } from "./add-entries";

const catalog: Catalog = {
  profiles: [
    { id: "pwsh", name: "PowerShell", icon: "terminal", isDefault: true },
    { id: "cmd", name: "Command Prompt", icon: "not-a-glyph", isDefault: false },
  ],
  agents: [],
  problems: [],
};

describe("N-06 the Add flyout's entries", () => {
  it("n06_add_terminal: Terminal opens the default shell; each shell is a choice under it", () => {
    const newTerminal = vi.fn();
    const actions = { newTerminal } as unknown as Actions;
    const [section] = addSections([TERMINAL_ENTRY], catalog, actions);
    expect(section?.label).toBe("Add a panel");
    expect(section?.items.map((i) => [i.label, i.inset === true, i.hint])).toEqual([
      ["Terminal", false, "PowerShell"],
      ["PowerShell", true, undefined],
      ["Command Prompt", true, undefined],
    ]);
    // A profile icon the font lacks falls back to the terminal glyph.
    expect(section?.items[2]?.icon).toBe("terminal");
    section?.items[0]?.onSelect();
    expect(newTerminal).toHaveBeenLastCalledWith();
    section?.items[2]?.onSelect();
    expect(newTerminal).toHaveBeenLastCalledWith(undefined, "cmd");
  });

  it("n06_add_registry: entries in order, one section each; a later panel kind joins the same way", () => {
    const entries = createAddRegistry();
    entries.register(TERMINAL_ENTRY);
    const open = vi.fn();
    const board: AddEntry = { id: "plugin.board", order: 10, label: "Board", icon: "add", open };
    const remove = entries.register(board);
    expect(entries.list().map((e) => e.id)).toEqual(["wolfcmd.terminal", "plugin.board"]);
    const sections = addSections(
      entries.list(),
      { profiles: [], agents: [], problems: [] },
      {} as Actions,
    );
    expect(sections).toHaveLength(2);
    expect(sections[1]?.label).toBeUndefined();
    expect(sections[1]?.items.map((i) => i.label)).toEqual(["Board"]);
    sections[1]?.items[0]?.onSelect();
    expect(open).toHaveBeenCalledOnce();
    expect(() => entries.register(board)).toThrow(/already registered/);
    remove();
    expect(entries.list().map((e) => e.id)).toEqual(["wolfcmd.terminal"]);
  });
});
