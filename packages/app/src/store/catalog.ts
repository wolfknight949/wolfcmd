// N-03 / N-06: what this computer offers, read once at start (`main.tsx`): the shell profiles
// (a panel header names its shell by them) and the agents (the Agents menu, the empty tab, an
// agent panel's name and color), and N-09 the plugin problems (the Agents menu reads both again
// when it opens).
import type { AgentInfo, PluginProblem, ProfileInfo } from "@wolfcmd/bindings";
import { createStore } from "zustand/vanilla";

export interface Catalog {
  readonly profiles: readonly ProfileInfo[];
  readonly agents: readonly AgentInfo[];
  readonly problems: readonly PluginProblem[];
}

export const catalog = createStore<Catalog>(() => ({ profiles: [], agents: [], problems: [] }));

/** The name of profile `id`, or of the default profile when the panel has none. */
export function profileName(
  profiles: readonly ProfileInfo[],
  id: string | null | undefined,
): string | undefined {
  const profile =
    (id == null ? undefined : profiles.find((p) => p.id === id)) ??
    profiles.find((p) => p.isDefault);
  return profile?.name;
}
