// N-10: git worktrees through the core (git runs there, off the UI thread). The last listing of
// each folder is kept, so the workspace menu opens with what it showed before and updates when
// the fresh listing (read on every opening, never polled) arrives.
import { commands, type GitRepository } from "@wolfcmd/bindings";

import { unwrap } from "./ipc";

let listings: ReadonlyMap<string, GitRepository | null> = new Map();
const listeners = new Set<() => void>();

/** The last listing of each folder read so far (`null`: not in a repository). */
export function knownRepositories(): ReadonlyMap<string, GitRepository | null> {
  return listings;
}

/** Calls `listener` when a listing changed; returns the unsubscribe. */
export function onRepositories(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Reads `folder`'s repository again (`null` outside one), and keeps it when it changed. */
export async function readRepository(folder: string): Promise<GitRepository | null> {
  const repository = unwrap(await commands.gitWorktrees(folder));
  const before = listings.get(folder);
  if (before === undefined || JSON.stringify(before) !== JSON.stringify(repository)) {
    listings = new Map(listings).set(folder, repository);
    for (const listener of listeners) listener();
  }
  return repository;
}

/** Adds a worktree; returns its path (as git lists it). */
export async function addWorktree(
  folder: string,
  branch: string,
  newBranch: boolean,
  path: string,
): Promise<string> {
  return unwrap(await commands.gitWorktreeAdd(folder, branch, newBranch, path));
}

/**
 * Removes the worktree at `path` (the branch stays). The core ends `panels` (its workspace's
 * terminals) first; a tree with changes is refused unless `force`.
 */
export async function removeWorktree(
  path: string,
  force: boolean,
  panels: readonly string[],
): Promise<void> {
  unwrap(await commands.gitWorktreeRemove(path, force, [...panels]));
}
