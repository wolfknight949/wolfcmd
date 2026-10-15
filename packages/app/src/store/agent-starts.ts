// N-06: how this run's agent panels start, in memory only. `actions.ts` marks the panels it
// opens or copies as fresh agents; `TerminalPanel` reads them when its shell is ready.

/** Agent panels opened (or copied) in this run: they start a new session; restored ones resume. */
export const freshAgents = new Set<string>();

/**
 * Agents and folders (`model/agents.ts` `restoreStart`) whose latest session a restored panel of
 * this run already continues: another one of them opens the agent's picker instead.
 */
export const continuing = new Set<string>();
