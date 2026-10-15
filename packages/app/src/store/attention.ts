// N-02: what terminals ask of the user, per panel, in memory only: a program that wants
// attention (OSC 9 / OSC 777, the bell, a long or watched command that ended) and OSC 9;4
// progress. The panel header shows both; a tab pill shows a calm mark while one of its panels
// wants the user. Nothing here while the user is looking at the panel; looking clears it.
import { createStore } from "zustand/vanilla";

/** OSC 9;4 progress, shown in the panel header. */
export interface TerminalProgress {
  readonly state: "normal" | "error" | "indeterminate" | "paused";
  /** 0…100. */
  readonly value: number;
}

/** Panel ID → the program's latest message. */
export const attention = createStore<Readonly<Record<string, string>>>(() => ({}));
/** Panel ID → its progress. */
export const progress = createStore<Readonly<Record<string, TerminalProgress>>>(() => ({}));

function without<T>(all: Readonly<Record<string, T>>, key: string): Readonly<Record<string, T>> {
  const { [key]: _gone, ...rest } = all;
  return rest;
}

/** The panel's program wants the user (`looking`: the user sees the panel now: nothing). */
export function requestAttention(panelId: string, message: string, looking: boolean): void {
  if (looking) return;
  if (attention.getState()[panelId] === message) return;
  attention.setState({ [panelId]: message });
}

/** The user looked at the panel (or it went away). */
export function clearAttention(panelId: string): void {
  if (!(panelId in attention.getState())) return;
  attention.setState(without(attention.getState(), panelId), true);
}

/** OSC 9;4 progress; `undefined` clears it. */
export function setProgress(panelId: string, value: TerminalProgress | undefined): void {
  const all = progress.getState();
  if (value === undefined) {
    if (panelId in all) progress.setState(without(all, panelId), true);
    return;
  }
  progress.setState({ [panelId]: value });
}

/** Whether any of `panelIds` wants the user (a tab's mark). */
export function wantsAttention(
  all: Readonly<Record<string, string>>,
  panelIds: readonly string[],
): boolean {
  return panelIds.some((id) => id in all);
}
