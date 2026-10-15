// N-11: which panels' shells run a command now, from shell integration's marks (OSC 133: C a
// command started, A/B/D the shell is at its prompt again), memory only. Closing such a panel
// asks first. Set only at those marks, never per output chunk; a shell without integration (or
// one that marks no command starts, cmd) never counts as running.
const running = new Set<string>();

/** The panel's shell started (`true`) or ended (`false`) a command. */
export function commandRunning(panelId: string, runs: boolean): void {
  if (runs) running.add(panelId);
  else running.delete(panelId);
}

/** Whether the panel's shell runs a command now. */
export function commandRuns(panelId: string): boolean {
  return running.has(panelId);
}
