# N-03: Context menus and maximizing a panel

> Status: Implemented · [Roadmap](../ROADMAP.md) N-03: simple context menus on the objects people work with, and maximizing a panel

## Goal
A right-click (or Shift+F10, or the Menu key) on the objects people work with offers only the actions they expect there, and a panel can fill its tab for a while and go back, without losing anything. Judged by the 1–2 terminal feel: nothing new to learn, nothing in the way.

## Context menus
One ui-kit primitive, `ContextMenu`: the same items, keys, type-ahead and opaque flyout as `Menu` (a Radix dropdown opened at an invisible anchor placed at the point, with its top left corner there). It closes with Esc or a click outside and gives the focus back to what had it (the terminal, the menu row), unless an item moved it (a rename field, a dialog). A `Menu` item can carry its own context menu (`MenuItem.contextMenu`), drawn over that menu, which stays open. The item lists are pure functions (`packages/app/src/chrome/context-menus.ts`, tested).

| Object | Items (sections) | Without the menu |
|---|---|---|
| Tab pill | Rename · New tab, Duplicate · Close, Close others, Close to the right | double-click; Ctrl+Shift+T; Ctrl+Shift+D; middle-click or ×; closing the pills one by one |
| Panel header | Split right, Split down, Maximize / Restore · Rename · Close panel | the header's buttons and Alt+Shift+= / -; the button, a double-click on the header, Ctrl+Shift+Enter; × and Ctrl+Shift+W |
| Terminal | Copy, Paste, Select all · Find, Clear · Split right, Split down, Maximize / Restore | Ctrl+C / Ctrl+V or a right-click; Ctrl+Shift+A; Ctrl+Shift+F; Ctrl+Shift+K; as the header |
| Workspace row (switcher) | Rename…, Open in File Explorer (with a folder) · Remove worktree… (worktrees), Close workspace | Close workspace and Remove worktree… in the switcher for the shown workspace |

- Disabled, not hidden, when it can't run now: Copy without a selection, Close others with one tab, Close to the right on the last tab, Maximize in a tab's only panel. Items that depend on what the object is (a folder, a worktree) are left out.
- Each item shows its key or gesture (Cmd instead of Ctrl on macOS where the key uses `primaryModifier`). Rename of a panel or a workspace has no key: a double-click on a header maximizes (a title bar's convention) and terminal keys belong to the programs. Close others and Close to the right are menu-only bulk forms of Close.
- Nothing on empty chrome: the title bar's empty space keeps the system menu, the panel area and empty tabs have none. No browser menu anywhere (WebView2's are off; every `contextmenu` is handled or prevented).
- Duplicate copies the tab's layout, folders and names with new IDs; agent panels become fresh agents with new sessions, as copied worktree tabs do. Closing tabs asks nothing, as closing one tab never did.
- Clear empties the view's scrollback and screen above the prompt (xterm `clear`); the shell is untouched. The core's own replay buffer is not cleared, so a reload shows the old lines again.
- Rename on a pill or a header edits in place (Enter saves, Esc cancels, an empty name gives the default back); a workspace's Rename… is a small dialog, because its row lives inside the switcher menu.
- Open in File Explorer goes through the core (`app_open_link` with the folder: `open.rs` opens folders in the file manager and never runs anything). Finder on macOS, the file manager on Linux.

### The keyboard
Shift+F10 and the Menu key open the focused object's menu: `keys.ts` catches them first and sends that element the `contextmenu` event a right-click would, marked as the keyboard's (`openContextMenuFrom`, `isKeyboardMenu`), at the element's bottom left (a terminal's is its cursor). The browser's own event for these keys is suppressed (on Windows the Menu key's comes on keyup), so it never arrives twice. In a panel the keyboard is in its terminal, so Shift+F10 there opens the terminal's menu, which carries the panel's layout items too (as Windows Terminal's and VS Code's terminal menus do); the header's own menu is the pointer's. Inside the switcher, Shift+F10 on a highlighted workspace row opens that row's menu.

### A right-click in a terminal (decision)
Today a right-click copies the selection or pastes, as Windows Terminal does. That stays the Windows behavior:
- Windows Terminal and VS Code's terminal on Windows (`rightClickBehavior: copyPaste`) both do this by default; it is the most frequent clipboard action in one click, and the users of this app expect it.
- **Shift+right-click** opens the terminal's menu on Windows; Shift+F10 and the Menu key always do.
- On macOS and Linux a plain right-click opens the menu (their convention, VS Code's default there).
- A program that tracks the mouse (an agent's full-screen TUI, vim, htop) gets the right-click itself: WolfCmd does nothing with it. Shift+right-click still opens the menu there, because xterm never reports a Shift+click to the program (the Windows Terminal rule).
- The rule is one pure function (`terminal/context-menu.ts` `rightClickAction`). A setting for the right-click can come with the Settings dialog (N-07) if users ask for a menu on Windows.

## Maximize
- **Model:** `Tab.maximized: Option<String>` (a panel ID) in `wcmd-state`, serde default (files without it load tiled; a test), cleared by `normalized()` when it points at no panel. The UI treats it as set only while the tab has another panel (`maximizedPanel`). `toggleMaximize` sets it (and the focus) or clears it.
- **Ends it:** a split (`openPanel`), a drop (`dropPanel`, and the header drag clears it as the drag starts, so the other panels are there to drop on), closing the maximized panel or all but one, focusing a hidden panel (`focusPanel`). Esc does not (it belongs to the terminal).
- **Triggers:** the header's button (FullScreenMaximize, turning into FullScreenMinimize "Restore"; Restore stays visible, Maximize shows on hover like Split), a double-click on the header outside its buttons, Ctrl+Shift+Enter (Cmd on macOS), and both context menus.
- **View:** `TabView` gives the maximized card the whole area and parks the tab's other cards exactly like a hidden tab's: their size kept, off screen, invisible, their terminals told `setVisible(false)`. Nothing is unmounted, so their shells, screens and scrollback are there when the tiles come back; no PTY resize for them. Dividers are hidden while a panel is maximized; Alt+arrows see only the maximized panel.
- **State shown:** the header's Restore button, and a quiet FullScreenMaximize glyph on the tab's pill ("A panel is maximized").
- **Saved:** a restart opens the tab maximized again.

## Tests
- Rust: a file without `maximized` loads tiled and a maximized one round-trips; a maximize pointing at a gone panel is cleared.
- Model (`model/maximize.test.ts`, `model/tabs.test.ts`): maximize, restore, a lone panel, closing the maximized panel, split and drop end it, focusing a hidden panel; duplicate, close others, close to the right, renaming a panel.
- Menus (`chrome/context-menus.test.ts`): the items and their disabled states per object and state; `terminal/context-menu.test.ts`: the right-click rule and the edit keys; ui-kit `ContextMenu.test.tsx`: opening at a point, focus back after Esc, the keyboard keys, a row's own menu over its menu; `TabView.test.tsx`: a maximize parks the others without a remount.
- End to end (`tests/e2e/src/menus.e2e.ts`): maximize then restore keeps both shells and their text, a double-click maximizes and a restart keeps it; a pill's Close others leaves one tab; Shift+F10 opens the terminal's menu and its Maximize works; a header's menu renames the panel; a workspace row's menu renames the workspace.
