// N-02: a command's menu, opened by a click on its gutter dot: copy its line or output, select
// its output, type it again at the prompt, find in its output, or be told when it ends.
import { Menu, type MenuItem } from "@wolfcmd/ui-kit";

import { commandSummary, type MarkActions, type MarkInfo } from "../terminal/marks";

/** What a command's menu can do (the panel carries it out). */
export type MarkAction =
  "copyCommand" | "copyOutput" | "selectOutput" | "rerun" | "find" | "notify";

/** The menu's items, in order; dimmed or left out as `actions` says (pure, tested). */
export function markMenuItems(actions: MarkActions, run: (action: MarkAction) => void): MenuItem[] {
  const item = (
    id: MarkAction,
    label: string,
    icon: MenuItem["icon"],
    enabled: boolean,
  ): MenuItem => ({
    id,
    label,
    ...(icon === undefined ? {} : { icon }),
    ...(enabled ? {} : { disabled: true }),
    onSelect: () => {
      run(id);
    },
  });
  const items = [
    item("copyCommand", "Copy command", "copy", actions.copyCommand),
    item("copyOutput", "Copy output", "copy", actions.copyOutput),
    item("selectOutput", "Select output", undefined, actions.selectOutput),
    item("rerun", "Rerun (types it, you press Enter)", "restart", actions.rerun),
    item("find", "Find in this output", "search", actions.find),
  ];
  if (actions.notify !== undefined) {
    items.push(item("notify", "Notify me when it finishes", "bell", actions.notify));
  }
  return items;
}

/**
 * The ui-kit menu, anchored by an invisible trigger where the dot is (`left`/`top` inside the
 * terminal's box). The trigger can't be reached with Tab; when the menu gives the focus back
 * to it, `onFocusBack` hands it on (to the terminal, or the find bar the menu opened).
 */
export function MarkMenu({
  info,
  actions,
  left,
  top,
  onAction,
  onClose,
  onFocusBack,
}: {
  readonly info: MarkInfo;
  readonly actions: MarkActions;
  readonly left: number;
  readonly top: number;
  readonly onAction: (action: MarkAction) => void;
  readonly onClose: () => void;
  readonly onFocusBack: () => void;
}) {
  const command = commandSummary(info.command) || "a command";
  return (
    <Menu
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      sections={[{ items: markMenuItems(actions, onAction) }]}
      trigger={
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Actions for ${command}`}
          onFocus={onFocusBack}
          style={{ left, top }}
          className="pointer-events-none absolute size-px opacity-0"
        />
      }
    />
  );
}
