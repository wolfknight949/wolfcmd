// N-04: the workspace switcher at the top left (no sidebar; a workspace holds
// tabs, like Wave): every workspace, New workspace, Open folder…, and the shown workspace's
// Remote Control choice and Close. N-10: each repository's worktrees under its workspace (read
// from git when the menu opens, never polled), New worktree… and Remove worktree…; the button
// says "repo › branch" while a worktree workspace is shown. N-03: each workspace row has its own
// context menu (Rename…, open its folder, Remove worktree…, Close workspace) over the switcher.
// N-07: Settings… at the end.
import type { Document, Workspace } from "@wolfcmd/bindings";
import { cn, GLYPHS, Menu, type MenuItem, type MenuSection } from "@wolfcmd/ui-kit";
import { useMemo, useRef, useState, useSyncExternalStore } from "react";

import type { Actions } from "../actions";
import { knownRepositories, onRepositories, readRepository } from "../core/git";
import {
  activeWorkspace,
  folderName,
  mainOf,
  workspaceColor,
  workspaceName,
} from "../model/document";
import { remoteControlOn } from "../model/remote-control";
import { menuRows, titleName } from "../model/worktrees";
import type { FullSettings } from "../store/settings";
import { workspaceMenu } from "./context-menus";
import { RenameDialog } from "./RenameDialog";
import { openSettings } from "./settings-open";
import { SwitcherDot, useWorkspaceMarks } from "./WorkspaceActivity";
import { NewWorktreeDialog, RemoveWorktreeDialog } from "./WorktreeDialog";

/** N-01: a workspace's accent color as a CSS color. */
const workspaceSwatch = (doc: Document, workspace: Workspace) =>
  `var(--wc-workspace-${String(workspaceColor(doc, workspace))})`;

export interface WorkspaceMenuProps {
  readonly document: Document;
  readonly actions: Actions;
  readonly settings: FullSettings;
}

/** The dialog the menu opened. */
type Open =
  | { readonly kind: "new"; readonly mainId: string }
  | { readonly kind: "remove"; readonly id: string }
  | { readonly kind: "rename"; readonly id: string };

export function WorkspaceMenu({ document: doc, actions, settings }: WorkspaceMenuProps) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<Open | undefined>(undefined);
  const trigger = useRef<HTMLButtonElement>(null);
  const listings = useSyncExternalStore(onRepositories, knownRepositories);
  const agentMarks = useWorkspaceMarks(doc);
  const agentHint = (id: string) => {
    const mark = agentMarks.get(id);
    return mark === undefined ? {} : { hint: mark };
  };

  const shown = activeWorkspace(doc);
  const folder = shown?.folder ?? null;
  const shownMain = shown === undefined ? undefined : (mainOf(doc, shown) ?? shown);
  // Each plain workspace's repository, as last read (by workspace ID).
  const repositories = useMemo(
    () =>
      new Map(
        doc.workspaces.flatMap((w) =>
          w.folder == null ? [] : [[w.id, listings.get(w.folder) ?? null] as const],
        ),
      ),
    [doc.workspaces, listings],
  );
  const mainRepository =
    shownMain === undefined ? undefined : (repositories.get(shownMain.id) ?? undefined);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) return;
    // N-10: the worktrees as they are now (git may have changed outside WolfCmd).
    for (const workspace of doc.workspaces) {
      if (workspace.folder != null && mainOf(doc, workspace) === undefined) {
        readRepository(workspace.folder).catch((error: unknown) => {
          console.warn("could not list the worktrees", error);
        });
      }
    }
  };

  /** N-03: a workspace row's own menu. */
  const rowMenu = (workspace: Workspace) => {
    const folder = workspace.folder ?? null;
    return {
      label: `Actions for ${workspaceName(doc, workspace)}`,
      sections: workspaceMenu(
        { folder: folder !== null, worktree: mainOf(doc, workspace) !== undefined },
        {
          rename: () => {
            setDialog({ kind: "rename", id: workspace.id });
          },
          reveal: () => {
            if (folder !== null) actions.revealFolder(folder);
          },
          removeWorktree: () => {
            setDialog({ kind: "remove", id: workspace.id });
          },
          close: () => {
            actions.closeWorkspace(workspace.id);
          },
        },
      ),
    };
  };

  const rows: MenuItem[] = menuRows(doc, repositories).map((row) =>
    row.kind === "workspace"
      ? {
          id: row.workspace.id,
          label: workspaceName(doc, row.workspace),
          inset: row.inset,
          ...(row.inset && row.workspace.folder != null ? { title: row.workspace.folder } : {}),
          checked: row.workspace.id === doc.active,
          ...agentHint(row.workspace.id),
          onSelect: () => {
            actions.activateWorkspace(row.workspace.id);
          },
          contextMenu: rowMenu(row.workspace),
        }
      : {
          id: `worktree:${row.worktree.path}`,
          label: row.worktree.branch ?? folderName(row.worktree.path),
          inset: true,
          title: row.worktree.path,
          checked: false,
          onSelect: () => {
            actions.openWorktree(
              row.main.id,
              row.worktree.path,
              row.worktree.branch ?? folderName(row.worktree.path),
            );
          },
        },
  );

  const sections: MenuSection[] = [
    { label: "Workspaces", radio: true, items: rows },
    {
      items: [
        {
          id: "new",
          label: "New workspace",
          icon: "add",
          hint: "Ctrl+Shift+N",
          onSelect: () => {
            actions.newWorkspace();
          },
        },
        {
          id: "open-folder",
          label: "Open folder…",
          icon: "folderOpen",
          onSelect: () => {
            void actions.openFolder();
          },
        },
        ...(shownMain === undefined || mainRepository == null
          ? []
          : [
              {
                id: "new-worktree",
                label: "New worktree…",
                onSelect: () => {
                  setDialog({ kind: "new", mainId: shownMain.id });
                },
              },
            ]),
      ],
    },
    {
      items: [
        ...(folder === null
          ? []
          : [
              {
                id: "remote-control",
                label: "Start agents with Remote Control",
                checked: remoteControlOn(settings.agents, folder),
                onSelect: () => {
                  actions.toggleRemoteControl(folder);
                },
              },
            ]),
        ...(shown === undefined || mainOf(doc, shown) === undefined
          ? []
          : [
              {
                id: "remove-worktree",
                label: "Remove worktree…",
                onSelect: () => {
                  setDialog({ kind: "remove", id: shown.id });
                },
              },
            ]),
        ...(shown === undefined
          ? []
          : [
              {
                id: "close",
                label: "Close workspace",
                onSelect: () => {
                  actions.closeWorkspace(shown.id);
                },
              },
            ]),
      ],
    },
    // N-07: Settings (also the right bar's foot and Ctrl+,).
    {
      items: [
        {
          id: "settings",
          label: "Settings…",
          icon: "settings",
          hint: "Ctrl+,",
          onSelect: () => {
            openSettings(trigger.current);
          },
        },
      ],
    },
  ];
  const name = shown === undefined ? "WolfCmd" : titleName(doc, shown);
  const closeDialog = () => {
    setDialog(undefined);
  };
  const dialogMain =
    dialog?.kind === "new" ? doc.workspaces.find((w) => w.id === dialog.mainId) : undefined;
  const dialogRepository = dialogMain === undefined ? undefined : repositories.get(dialogMain.id);
  const removing =
    dialog?.kind === "remove" ? doc.workspaces.find((w) => w.id === dialog.id) : undefined;
  const renaming =
    dialog?.kind === "rename" ? doc.workspaces.find((w) => w.id === dialog.id) : undefined;
  return (
    <>
      <Menu
        open={open}
        onOpenChange={onOpenChange}
        trigger={
          <button
            ref={trigger}
            type="button"
            title={folder ?? name}
            className={cn(
              "wc-press wc-no-drag flex h-(--wc-tab-h) min-w-12 max-w-72 shrink items-center gap-2 rounded-control px-2.5 text-sm font-medium text-fg",
              "hover:bg-fill-hover data-[state=open]:bg-fill-strong",
            )}
          >
            <span className="truncate">{name}</span>
            {shown !== undefined && (
              // N-01: the workspace's accent color (its focused panel's border has it too).
              <span
                aria-hidden
                className="-order-1 size-2 shrink-0 rounded-full"
                style={{ backgroundColor: workspaceSwatch(doc, shown) }}
              />
            )}
            <SwitcherDot marks={agentMarks} />
            <span aria-hidden className="shrink-0 font-icons text-icon-xs text-fg-muted">
              {GLYPHS.chevronDown}
            </span>
          </button>
        }
        sections={sections}
      />
      {dialogMain !== undefined && dialogRepository != null && (
        <NewWorktreeDialog
          main={dialogMain}
          mainName={workspaceName(doc, dialogMain)}
          repository={dialogRepository}
          actions={actions}
          onClose={closeDialog}
          returnFocus={trigger}
        />
      )}
      {renaming !== undefined && (
        <RenameDialog
          title="Rename workspace"
          name={renaming.name ?? ""}
          placeholder={workspaceName(doc, { ...renaming, name: "" })}
          onRename={(next) => {
            actions.renameWorkspace(renaming.id, next);
          }}
          onClose={closeDialog}
          returnFocus={trigger}
        />
      )}
      {removing !== undefined && (
        <RemoveWorktreeDialog
          workspace={removing}
          branch={workspaceName(doc, removing)}
          actions={actions}
          onClose={closeDialog}
          returnFocus={trigger}
        />
      )}
    </>
  );
}
