// N-06: an agent panel across restarts, as pure functions: where its shell starts, whether its
// agent is started again, and how (its own session, the latest one in its folder, or the
// agent's picker when another panel already continues that one). N-03: an agent runs only in a
// terminal panel (`content.agent`).
import type { AgentRef, AgentStart } from "@wolfcmd/bindings";

import { folderKey } from "./document";
import type { PanelLeaf } from "./layout";
import { agentOf, changeTerminal, panelFolder } from "./panels";

/** Whether a restored panel starts its agent again: it still ran when WolfCmd closed. */
export function relaunches(panel: PanelLeaf): boolean {
  const agent = agentOf(panel);
  return agent !== undefined && agent.running !== false;
}

/**
 * The folder a panel's new shell starts in: the agent's own folder while the agent is to be
 * started again (agents keep their sessions per folder), else where the shell last was.
 */
export function startFolder(panel: PanelLeaf): string | null {
  const agentFolder = relaunches(panel) ? (agentOf(panel)?.cwd ?? null) : null;
  return agentFolder ?? panelFolder(panel);
}

/** What a panel reports about its agent: the folder it started in, or that it ended. */
export type AgentChange = Partial<Pick<AgentRef, "cwd" | "running">>;

/** `panel` with its agent changed by `change` (the same panel without an agent). */
export function withAgent(panel: PanelLeaf, change: AgentChange): PanelLeaf {
  return changeTerminal(panel, (t) =>
    t.agent == null ? t : { ...t, agent: { ...t.agent, ...change } },
  );
}

/** How a restored agent panel starts, and the claim it makes on its folder's latest session. */
export interface RestoreStart {
  readonly start: AgentStart;
  /** Add to `continuing`: this panel continues the latest session of that agent and folder. */
  readonly claims: string | undefined;
}

/**
 * How restored panel `panel` starts its agent: its own session when it has one. Without one
 * (Codex can't be given an ID), the latest session in its folder, unless another panel of this
 * run already continues it (its key is in `continuing`): then the agent's own picker, so two
 * panels never continue one session.
 */
export function restoreStart(panel: PanelLeaf, continuing: ReadonlySet<string>): RestoreStart {
  const agent = agentOf(panel);
  if (agent?.session != null)
    return { start: { kind: "resume", session: agent.session }, claims: undefined };
  const key = `${agent?.agent ?? ""}\n${folderKey(startFolder(panel) ?? "")}`;
  return continuing.has(key)
    ? { start: { kind: "pick" }, claims: undefined }
    : { start: { kind: "resume", session: null }, claims: key };
}
