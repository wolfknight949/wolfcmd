// N-02: the escape sequences agents and tools use to talk to the terminal. Pure functions;
// terminal-view.ts wires them to xterm.js.
import type { TerminalProgress } from "../store/attention";

/** OSC 52 payloads larger than this are ignored (a clipboard, not a file transfer). */
export const CLIPBOARD_LIMIT = 1024 * 1024;

export type Osc9 =
  | { readonly kind: "notify"; readonly message: string }
  | { readonly kind: "progress"; readonly progress: TerminalProgress | undefined }
  | { readonly kind: "other" };

const PROGRESS_STATES = [undefined, "normal", "error", "indeterminate", "paused"] as const;

/**
 * `OSC 9 ; <payload>`: a notification (`OSC 9 ; text`, iTerm2 / Windows Terminal), progress
 * (`OSC 9 ; 4 ; state ; percent`, Windows Terminal; state 0 clears it), or another numbered
 * sub-command such as `9;9` (the folder, handled by the core).
 */
export function parseOsc9(payload: string): Osc9 {
  const progress = /^4(?:;(\d*))?(?:;(\d*))?$/.exec(payload);
  if (progress) {
    const state = PROGRESS_STATES[Number(progress[1] ?? 0)];
    const value = Math.min(100, Math.max(0, Number(progress[2] ?? 0)));
    return { kind: "progress", progress: state === undefined ? undefined : { state, value } };
  }
  // Other numbered sub-commands (9;9 folder, 9;12…) are not messages.
  if (/^\d+(;|$)/.test(payload)) return { kind: "other" };
  return { kind: "notify", message: payload };
}

/** `OSC 777 ; notify ; <title> ; <body>` (urxvt / VTE / Ghostty). */
export function parseOsc777(payload: string): string | undefined {
  const [command, title = "", ...body] = payload.split(";");
  if (command !== "notify") return undefined;
  const text = [title, body.join(";")].filter((part) => part.length > 0).join(": ");
  return text || undefined;
}

/** Two progress reports look the same (the header is painted only when it changes). */
export function sameProgress(
  a: TerminalProgress | undefined,
  b: TerminalProgress | undefined,
): boolean {
  return a?.state === b?.state && a?.value === b?.value;
}

/**
 * `OSC 52 ; <targets> ; <base64>`: text to put on the clipboard. `undefined` for a read
 * request (`?`, never answered), invalid base64 or oversized payloads.
 */
export function parseOsc52(payload: string): string | undefined {
  const at = payload.indexOf(";");
  if (at < 0) return undefined;
  const data = payload.slice(at + 1);
  if (data === "?" || data.length > (CLIPBOARD_LIMIT * 4) / 3 + 4) return undefined;
  try {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Where the shell is, from its OSC 133 marks (shell integration). */
export type ShellPhase = "unknown" | "prompt" | "running";

/** `OSC 133 ; A|B|C|D…`: the new phase. */
export function phaseAfter133(payload: string, phase: ShellPhase): ShellPhase {
  switch (payload[0]) {
    case "A":
    case "B":
    case "D":
      return "prompt";
    case "C":
      return "running";
    default:
      return phase;
  }
}

/**
 * What Shift+Enter sends. A running program (an agent's prompt) gets Meta+Enter,
 * its newline key; a shell prompt gets a plain Enter. Without integration we can't tell,
 * so programs win.
 */
export function shiftEnterSequence(phase: ShellPhase): string {
  return phase === "prompt" ? "\r" : "\x1b\r";
}
