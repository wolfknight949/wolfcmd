// N-10: git worktrees in the workspace menu, as pure functions: which rows it shows (each main
// workspace, its worktree workspaces under it, then the repository's other worktrees), where a
// new worktree goes by default, and what a branch name means.
import type { Document, GitRepository, WorktreeInfo, Workspace } from "@wolfcmd/bindings";

import { mainOf, workspaceForFolder, workspaceName, worktreesOf } from "./document";

export type MenuRow =
  /** A workspace; `inset` when it is a worktree under its main workspace. */
  | { readonly kind: "workspace"; readonly workspace: Workspace; readonly inset: boolean }
  /** A worktree of `main`'s repository that has no workspace yet (made outside WolfCmd). */
  | { readonly kind: "worktree"; readonly main: Workspace; readonly worktree: WorktreeInfo };

/**
 * The workspace menu's rows: every plain workspace, each followed by its worktree workspaces
 * and then by the other worktrees `repositories` lists for it (by workspace ID; read when the
 * menu opens), except the main tree, gone ones and those that already have a workspace.
 */
export function menuRows(
  doc: Document,
  repositories: ReadonlyMap<string, GitRepository | null>,
): MenuRow[] {
  const rows: MenuRow[] = [];
  for (const workspace of doc.workspaces) {
    if (mainOf(doc, workspace) !== undefined) continue;
    rows.push({ kind: "workspace", workspace, inset: false });
    for (const worktree of worktreesOf(doc, workspace.id)) {
      rows.push({ kind: "workspace", workspace: worktree, inset: true });
    }
    for (const worktree of repositories.get(workspace.id)?.worktrees ?? []) {
      if (worktree.isMain || worktree.prunable) continue;
      if (workspaceForFolder(doc, worktree.path) !== undefined) continue;
      rows.push({ kind: "worktree", main: workspace, worktree });
    }
  }
  return rows;
}

/** A branch as one folder name: `feature/login` → `feature-login`. */
function folderFor(branch: string): string {
  return branch
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/^[.\s-]+|[.\s]+$/g, "");
}

/**
 * Where a new worktree for `branch` goes unless the user picks another place: next to the
 * repository, `<parent>\<repo>.worktrees\<branch>`.
 */
export function defaultWorktreePath(mainRoot: string, branch: string): string {
  const root = mainRoot.replace(/[\\/]+$/, "");
  const separator = root.includes("\\") || !root.includes("/") ? "\\" : "/";
  const cut = Math.max(root.lastIndexOf("\\"), root.lastIndexOf("/"));
  const parent = cut < 0 ? "" : root.slice(0, cut);
  const repo = root.slice(cut + 1);
  const folder = folderFor(branch);
  const container = `${parent}${separator}${repo}.worktrees`;
  return folder === "" ? container : `${container}${separator}${folder}`;
}

export type BranchUse =
  | { readonly kind: "none" }
  /** A new branch from the main tree's HEAD. */
  | { readonly kind: "new" }
  /** A branch that exists and is checked out nowhere. */
  | { readonly kind: "existing" }
  /** A branch checked out in the worktree at `path` (git refuses a second one). */
  | { readonly kind: "taken"; readonly path: string };

/** What `branch` means in `repository`. */
export function branchUse(repository: GitRepository, branch: string): BranchUse {
  const name = branch.trim();
  if (name === "") return { kind: "none" };
  const checkedOut = repository.worktrees.find((w) => w.branch === name);
  if (checkedOut !== undefined) return { kind: "taken", path: checkedOut.path };
  return repository.branches.includes(name) ? { kind: "existing" } : { kind: "new" };
}

/** The title bar's name for `workspace`: "repo › branch" for a worktree, else its own name. */
export function titleName(doc: Document, workspace: Workspace): string {
  const main = mainOf(doc, workspace);
  const name = workspaceName(doc, workspace);
  return main === undefined ? name : `${workspaceName(doc, main)} › ${name}`;
}
