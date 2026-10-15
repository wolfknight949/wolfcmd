// N-03: a terminal's context menu (Shift+right-click on Windows, a right-click elsewhere,
// Shift+F10 or the Menu key): the clipboard on top, find and clear, then the panel's layout
// (`chrome/context-menus.ts`). The panel carries out the chosen action.
import { ContextMenu, type MenuPoint } from "@wolfcmd/ui-kit";

import { terminalMenu } from "../chrome/context-menus";

export type TerminalMenuAction =
  "copy" | "paste" | "selectAll" | "find" | "clear" | "splitRight" | "splitDown" | "maximize";

export function TerminalMenu({
  at,
  selection,
  alone,
  maximized,
  onAction,
  onClose,
}: {
  readonly at: MenuPoint | undefined;
  /** Text was selected when it opened (Copy). */
  readonly selection: boolean;
  readonly alone: boolean;
  readonly maximized: boolean;
  readonly onAction: (action: TerminalMenuAction) => void;
  readonly onClose: () => void;
}) {
  const run = (action: TerminalMenuAction) => () => {
    onAction(action);
  };
  const sections = terminalMenu(
    selection,
    { alone, maximized },
    {
      copy: run("copy"),
      paste: run("paste"),
      selectAll: run("selectAll"),
      find: run("find"),
      clear: run("clear"),
      splitRight: run("splitRight"),
      splitDown: run("splitDown"),
      toggleMaximize: run("maximize"),
    },
  );
  return <ContextMenu at={at} label="Terminal actions" sections={sections} onClose={onClose} />;
}
