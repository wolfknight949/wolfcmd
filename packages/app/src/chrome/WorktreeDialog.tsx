// N-10: the New worktree and Remove worktree dialogs (ui-kit `Dialog`: the keyboard stays in
// it, Esc cancels, Enter confirms). Git runs in the core; its refusal is shown here, in a line
// that always takes its space, so nothing moves when a message appears.
import type { GitRepository, Workspace } from "@wolfcmd/bindings";
import { Button, Dialog, TextField } from "@wolfcmd/ui-kit";
import { type RefObject, useState } from "react";

import type { Actions } from "../actions";
import { errorText, isRefusal } from "../core/ipc";
import { folderKey } from "../model/document";
import { branchUse, defaultWorktreePath } from "../model/worktrees";

/** A failure or a refusal: two lines at most, always there (the full text on hover). */
function Problem({ text }: { readonly text: string | undefined }) {
  return (
    <p
      role={text === undefined ? undefined : "alert"}
      title={text}
      className="mt-3 line-clamp-2 min-h-9 text-sm text-danger"
    >
      {text}
    </p>
  );
}

export interface NewWorktreeDialogProps {
  readonly main: Workspace;
  readonly mainName: string;
  /** The main workspace's repository, as listed when the menu opened. */
  readonly repository: GitRepository;
  readonly actions: Actions;
  readonly onClose: () => void;
  readonly returnFocus: RefObject<HTMLElement | null>;
}

export function NewWorktreeDialog({
  main,
  mainName,
  repository,
  actions,
  onClose,
  returnFocus,
}: NewWorktreeDialogProps) {
  const [branch, setBranch] = useState("");
  // The location follows the branch until the user edits it.
  const [location, setLocation] = useState<string | undefined>(undefined);
  const [copy, setCopy] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const path = location ?? defaultWorktreePath(repository.mainRoot, branch);
  const use = branchUse(repository, branch);
  const head =
    repository.worktrees.find((w) => folderKey(w.path) === folderKey(repository.root))?.branch ??
    "HEAD";
  const branchHint =
    use.kind === "new"
      ? `A new branch from ${head}`
      : use.kind === "existing"
        ? "The existing branch"
        : `A new branch from ${head}, or an existing one`;
  const ready = !busy && path.trim() !== "" && (use.kind === "new" || use.kind === "existing");

  const create = () => {
    if (!ready) return;
    setBusy(true);
    setProblem(undefined);
    actions
      .newWorktree(main.id, {
        branch: branch.trim(),
        newBranch: use.kind === "new",
        path,
        copyFrom: copy ? repository.root : null,
      })
      .then(onClose, (error: unknown) => {
        setBusy(false);
        setProblem(errorText(error));
      });
  };

  return (
    <Dialog
      title="New worktree"
      onClose={onClose}
      onSubmit={create}
      returnFocus={returnFocus}
      footer={
        <>
          <Button variant="accent" submit disabled={!ready}>
            {busy ? "Creating…" : "Create"}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <TextField
          label="Branch"
          value={branch}
          autoFocus
          placeholder="feature/login"
          disabled={busy}
          onChange={(value) => {
            setBranch(value);
            setProblem(undefined);
          }}
          hint={use.kind === "taken" ? undefined : branchHint}
          error={use.kind === "taken" ? `Already checked out in ${use.path}` : undefined}
        />
        <TextField
          label="Location"
          value={path}
          disabled={busy}
          onChange={(value) => {
            setLocation(value);
            setProblem(undefined);
          }}
          hint="A new folder (or an empty one)"
        />
        <fieldset className="flex flex-col gap-2" disabled={busy}>
          <legend className="mb-2 text-md text-fg">Tabs</legend>
          <label className="flex items-center gap-2 text-md">
            <input
              type="radio"
              name="worktree-tabs"
              className="accent-accent"
              checked={copy}
              onChange={() => {
                setCopy(true);
              }}
            />
            Copy the tabs of {mainName}
          </label>
          <label className="flex items-center gap-2 text-md">
            <input
              type="radio"
              name="worktree-tabs"
              className="accent-accent"
              checked={!copy}
              onChange={() => {
                setCopy(false);
              }}
            />
            Empty
          </label>
        </fieldset>
      </div>
      <Problem text={problem} />
    </Dialog>
  );
}

export interface RemoveWorktreeDialogProps {
  readonly workspace: Workspace;
  readonly branch: string;
  readonly actions: Actions;
  readonly onClose: () => void;
  readonly returnFocus: RefObject<HTMLElement | null>;
}

export function RemoveWorktreeDialog({
  workspace,
  branch,
  actions,
  onClose,
  returnFocus,
}: RemoveWorktreeDialogProps) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  // After git refused (changes, a lock), the user may remove it anyway.
  const [refused, setRefused] = useState(false);

  const remove = () => {
    if (busy) return;
    setBusy(true);
    setProblem(undefined);
    actions.removeWorktree(workspace.id, refused).then(onClose, (error: unknown) => {
      setBusy(false);
      setRefused(isRefusal(error));
      setProblem(errorText(error));
    });
  };

  return (
    <Dialog
      title="Remove worktree?"
      onClose={onClose}
      onSubmit={remove}
      returnFocus={returnFocus}
      footer={
        <>
          <Button variant="danger" submit disabled={busy}>
            {busy ? "Removing…" : refused ? "Remove anyway" : "Remove"}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </>
      }
    >
      <p className="text-md">
        The terminals of <span className="font-medium">{branch}</span> end and its folder is
        deleted. The branch stays.
      </p>
      <p className="mt-2 truncate text-sm text-fg-muted" title={workspace.folder ?? undefined}>
        {workspace.folder}
      </p>
      <Problem text={problem} />
    </Dialog>
  );
}
