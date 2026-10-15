// N-03: the context menus' items (simple menus with only the best-practice actions), as pure
// functions of the object's state (tested). Each object has only the
// actions people expect on it; each item shows the key, click or button that does the same
// without the menu. Nothing on empty chrome. Ctrl on Windows and Linux, Cmd on macOS where the key
// uses `primaryModifier`.
import { isApple, isWindows, type MenuItem, type MenuSection } from "@wolfcmd/ui-kit";

const APPLE = isApple();
const PRIMARY = APPLE ? "Cmd" : "Ctrl";

/** The hints the menus and the header's buttons show. */
export const HINTS = {
  newTab: "Ctrl+Shift+T",
  duplicateTab: `${PRIMARY}+Shift+D`,
  renameTab: "Double-click",
  closeTab: "Middle-click",
  splitRight: "Alt+Shift+=",
  splitDown: "Alt+Shift+-",
  maximize: `${PRIMARY}+Shift+Enter`,
  closePanel: "Ctrl+Shift+W",
  copy: `${PRIMARY}+C`,
  paste: `${PRIMARY}+V`,
  selectAll: `${PRIMARY}+Shift+A`,
  find: `${PRIMARY}+Shift+F`,
  clear: `${PRIMARY}+Shift+K`,
} as const;

/** What the file manager is called here. */
const FILE_MANAGER = isWindows() ? "File Explorer" : APPLE ? "Finder" : "the file manager";

type Item = Omit<MenuItem, "onSelect">;

const item = (fields: Item, onSelect: () => void): MenuItem => ({ ...fields, onSelect });

/** What a tab pill's menu does (the pill renames inline). */
export interface TabMenuActions {
  readonly rename: () => void;
  readonly newTab: () => void;
  readonly duplicate: () => void;
  readonly close: () => void;
  readonly closeOthers: () => void;
  readonly closeToRight: () => void;
}

/** A tab pill: tab `index` of `count`. */
export function tabMenu(index: number, count: number, run: TabMenuActions): MenuSection[] {
  return [
    {
      items: [
        item({ id: "rename", label: "Rename", icon: "edit", hint: HINTS.renameTab }, run.rename),
      ],
    },
    {
      items: [
        item({ id: "new", label: "New tab", icon: "add", hint: HINTS.newTab }, run.newTab),
        item(
          { id: "duplicate", label: "Duplicate", icon: "duplicate", hint: HINTS.duplicateTab },
          run.duplicate,
        ),
      ],
    },
    {
      items: [
        item({ id: "close", label: "Close", icon: "close", hint: HINTS.closeTab }, run.close),
        item({ id: "close-others", label: "Close others", disabled: count < 2 }, run.closeOthers),
        item(
          { id: "close-right", label: "Close to the right", disabled: index >= count - 1 },
          run.closeToRight,
        ),
      ],
    },
  ];
}

/** What a panel's menus do. */
export interface PanelMenuActions {
  readonly splitRight: () => void;
  readonly splitDown: () => void;
  readonly toggleMaximize: () => void;
  readonly rename: () => void;
  readonly close: () => void;
}

/** The panel's layout state, for Maximize / Restore. */
export interface PanelLayoutState {
  /** It fills its tab now. */
  readonly maximized: boolean;
  /** The tab's only panel (nothing to maximize). */
  readonly alone: boolean;
}

/** What Split right, Split down and Maximize / Restore do. */
type LayoutActions = Pick<PanelMenuActions, "splitRight" | "splitDown" | "toggleMaximize">;

/** Split right, Split down and Maximize / Restore: the header's and the terminal's. */
function layoutSection(state: PanelLayoutState, run: LayoutActions): MenuSection {
  return {
    items: [
      item(
        { id: "split-right", label: "Split right", icon: "splitRight", hint: HINTS.splitRight },
        run.splitRight,
      ),
      item(
        { id: "split-down", label: "Split down", icon: "splitDown", hint: HINTS.splitDown },
        run.splitDown,
      ),
      item(
        state.maximized
          ? { id: "maximize", label: "Restore", icon: "unzoom", hint: HINTS.maximize }
          : {
              id: "maximize",
              label: "Maximize",
              icon: "zoom",
              hint: HINTS.maximize,
              disabled: state.alone,
            },
        run.toggleMaximize,
      ),
    ],
  };
}

/** A panel's header. */
export function panelMenu(state: PanelLayoutState, run: PanelMenuActions): MenuSection[] {
  return [
    layoutSection(state, run),
    { items: [item({ id: "rename", label: "Rename", icon: "edit" }, run.rename)] },
    {
      items: [
        item(
          { id: "close", label: "Close panel", icon: "close", hint: HINTS.closePanel },
          run.close,
        ),
      ],
    },
  ];
}

/** What the terminal's own items do. */
export interface TerminalMenuActions {
  readonly copy: () => void;
  readonly paste: () => void;
  readonly selectAll: () => void;
  readonly find: () => void;
  readonly clear: () => void;
}

/** Inside a terminal: the clipboard on top, then find and clear, then the panel's layout. */
export function terminalMenu(
  selection: boolean,
  state: PanelLayoutState,
  run: TerminalMenuActions & LayoutActions,
): MenuSection[] {
  return [
    {
      items: [
        item(
          { id: "copy", label: "Copy", icon: "copy", hint: HINTS.copy, disabled: !selection },
          run.copy,
        ),
        item({ id: "paste", label: "Paste", hint: HINTS.paste }, run.paste),
        item({ id: "select-all", label: "Select all", hint: HINTS.selectAll }, run.selectAll),
      ],
    },
    {
      items: [
        item({ id: "find", label: "Find", icon: "search", hint: HINTS.find }, run.find),
        item({ id: "clear", label: "Clear", icon: "clear", hint: HINTS.clear }, run.clear),
      ],
    },
    layoutSection(state, run),
  ];
}

/** What a workspace row's menu does. */
export interface WorkspaceMenuActions {
  readonly rename: () => void;
  readonly reveal: () => void;
  readonly removeWorktree: () => void;
  readonly close: () => void;
}

/** A workspace in the switcher: with a folder (`reveal`), a worktree (`Remove worktree…`). */
export function workspaceMenu(
  workspace: { readonly folder: boolean; readonly worktree: boolean },
  run: WorkspaceMenuActions,
): MenuSection[] {
  return [
    {
      items: [
        item({ id: "rename", label: "Rename…", icon: "edit" }, run.rename),
        ...(workspace.folder
          ? [
              item(
                { id: "reveal", label: `Open in ${FILE_MANAGER}`, icon: "folderOpen" },
                run.reveal,
              ),
            ]
          : []),
      ],
    },
    {
      items: [
        ...(workspace.worktree
          ? [item({ id: "remove-worktree", label: "Remove worktree…" }, run.removeWorktree)]
          : []),
        item({ id: "close", label: "Close workspace", icon: "close" }, run.close),
      ],
    },
  ];
}
