// N-03: which items each context menu shows, in which state.
import type { MenuSection } from "@wolfcmd/ui-kit";
import { describe, expect, it, vi } from "vitest";

import { panelMenu, tabMenu, terminalMenu, workspaceMenu } from "./context-menus";

/** The items as "label" (dimmed: "label (off)"), one array per section. */
const shape = (sections: readonly MenuSection[]) =>
  sections.map((section) =>
    section.items.map((item) => (item.disabled === true ? `${item.label} (off)` : item.label)),
  );

const spy = () => ({
  rename: vi.fn(),
  newTab: vi.fn(),
  duplicate: vi.fn(),
  close: vi.fn(),
  closeOthers: vi.fn(),
  closeToRight: vi.fn(),
  splitRight: vi.fn(),
  splitDown: vi.fn(),
  toggleMaximize: vi.fn(),
  copy: vi.fn(),
  paste: vi.fn(),
  selectAll: vi.fn(),
  find: vi.fn(),
  clear: vi.fn(),
  reveal: vi.fn(),
  removeWorktree: vi.fn(),
});

describe("N-03 context menus", () => {
  it("n03_tab_menu: close others and to the right only when there are such tabs", () => {
    const run = spy();
    expect(shape(tabMenu(0, 3, run))).toEqual([
      ["Rename"],
      ["New tab", "Duplicate"],
      ["Close", "Close others", "Close to the right"],
    ]);
    expect(shape(tabMenu(2, 3, run))[2]).toEqual([
      "Close",
      "Close others",
      "Close to the right (off)",
    ]);
    expect(shape(tabMenu(0, 1, run))[2]).toEqual([
      "Close",
      "Close others (off)",
      "Close to the right (off)",
    ]);
    tabMenu(0, 3, run)[1]?.items[1]?.onSelect();
    expect(run.duplicate).toHaveBeenCalledOnce();
    // Every item says how to do it without the menu, or is a menu-only bulk close.
    const hints = tabMenu(0, 3, run).flatMap((s) => s.items.map((i) => i.hint));
    expect(hints).toEqual([
      "Double-click",
      "Ctrl+Shift+T",
      "Ctrl+Shift+D",
      "Middle-click",
      undefined,
      undefined,
    ]);
  });

  it("n03_panel_menu: Maximize or Restore by state; a lone panel can't maximize", () => {
    const run = spy();
    expect(shape(panelMenu({ alone: false, maximized: false }, run))).toEqual([
      ["Split right", "Split down", "Maximize"],
      ["Rename"],
      ["Close panel"],
    ]);
    expect(shape(panelMenu({ alone: false, maximized: true }, run))[0]).toEqual([
      "Split right",
      "Split down",
      "Restore",
    ]);
    expect(shape(panelMenu({ alone: true, maximized: false }, run))[0]).toEqual([
      "Split right",
      "Split down",
      "Maximize (off)",
    ]);
    panelMenu({ alone: false, maximized: true }, run)[0]?.items[2]?.onSelect();
    expect(run.toggleMaximize).toHaveBeenCalledOnce();
    expect(panelMenu({ alone: false, maximized: false }, run)[0]?.items[2]?.hint).toBe(
      "Ctrl+Shift+Enter",
    );
  });

  it("n03_terminal_menu: Copy only with a selection; the clipboard on top", () => {
    const run = spy();
    const tiled = { alone: false, maximized: false };
    expect(shape(terminalMenu(false, tiled, run))).toEqual([
      ["Copy (off)", "Paste", "Select all"],
      ["Find", "Clear"],
      ["Split right", "Split down", "Maximize"],
    ]);
    expect(shape(terminalMenu(true, tiled, run))[0]?.[0]).toBe("Copy");
    terminalMenu(true, tiled, run)[1]?.items[1]?.onSelect();
    expect(run.clear).toHaveBeenCalledOnce();
  });

  it("n03_workspace_menu: open the folder only with one, remove only a worktree", () => {
    const run = spy();
    expect(shape(workspaceMenu({ folder: false, worktree: false }, run))).toEqual([
      ["Rename…"],
      ["Close workspace"],
    ]);
    const worktree = shape(workspaceMenu({ folder: true, worktree: true }, run));
    expect(worktree[0]?.[1]).toMatch(/^Open in /);
    expect(worktree[1]).toEqual(["Remove worktree…", "Close workspace"]);
  });
});
