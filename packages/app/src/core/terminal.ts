// N-02: the terminal session client. A view opens its panel's session in the core: it attaches
// to the running shell (the stream starts with a replay of its screen and scrollback) or starts
// one. Output arrives on a Channel as raw bytes and goes straight into xterm (never through
// React state). Closing the view only detaches: the shell ends when its panel leaves the
// workspace document, its program exits, or the app quits.
import { Channel } from "@tauri-apps/api/core";
import { commands } from "@wolfcmd/bindings";

import { report, unwrap } from "./ipc";

/**
 * Output is acknowledged in steps this big. The core pauses the shell only above 8 MiB
 * unacknowledged (crates/wcmd-app/src/session/flow.rs), so interactive use never acks.
 */
const ACK_STEP_BYTES = 128 * 1024;

/** Sums processed bytes and calls `send` once at least `step` have accumulated. */
export function createAckCounter(
  send: (bytes: number) => void,
  step = ACK_STEP_BYTES,
): (bytes: number) => void {
  let pending = 0;
  return (bytes) => {
    pending += bytes;
    if (pending >= step) {
      send(pending);
      pending = 0;
    }
  };
}

export interface StreamHandlers {
  readonly onOutput: (data: Uint8Array) => void;
  readonly onExit: (code: number | null) => void;
  readonly onCwd?: (cwd: string) => void;
  readonly onAgentExit?: () => void;
}

/**
 * `pty_open` stream messages: raw output bytes, `{ cwd }` when the shell reports a new folder,
 * `{ agentExited: true }` when the agent typed into it ended (N-06), then one
 * `{ exited: { code } }`.
 */
export function routeStreamMessage(message: unknown, handlers: StreamHandlers): void {
  if (message instanceof ArrayBuffer) {
    handlers.onOutput(new Uint8Array(message));
    return;
  }
  if (typeof message !== "object" || message === null) return;
  if ("cwd" in message) {
    const { cwd } = message;
    if (typeof cwd === "string") handlers.onCwd?.(cwd);
    return;
  }
  if ("agentExited" in message) {
    if (message.agentExited === true) handlers.onAgentExit?.();
    return;
  }
  if ("exited" in message) {
    const { exited } = message as { exited: { code: unknown } };
    handlers.onExit(typeof exited.code === "number" ? exited.code : null);
  }
}

export interface OpenOptions {
  readonly cols: number;
  readonly rows: number;
  readonly profile: string | undefined;
  readonly cwd: string | undefined;
  /** The panel: its running session is attached to, its scrollback saved under it (N-05). */
  readonly panelId: string;
  /** Output; call `done` once xterm has processed it (flow control). */
  readonly onOutput: (data: Uint8Array, done: () => void) => void;
  readonly onCwd: (cwd: string) => void;
  /** N-06: the agent typed with `startAgent` ended (the shell is back at a prompt). */
  readonly onAgentExit: () => void;
  readonly onExit: (code: number | null) => void;
  /**
   * N-06: the view is gone already (React StrictMode's first mount): its open, still waiting
   * for the panel's previous one, never reaches the core, so the next view starts the shell and
   * gets its `onReady` (an agent panel's start line).
   */
  readonly cancelled?: () => boolean;
}

/** An open given up because its view went first (`OpenOptions.cancelled`). */
class OpenCancelled extends Error {
  constructor() {
    super("the view closed before its session opened");
    this.name = "OpenCancelled";
  }
}

export interface TerminalSession {
  /** N-06: the shell's profile (the default one when the panel's is gone). */
  readonly profileId: string;
  /** N-06: the shell marks its prompts (shell integration), so readiness needs no guess. */
  readonly integrated: boolean;
  /** N-06: the agent typed into this session has already ended (seen by a later view). */
  readonly agentExited: boolean;
  /** N-06: the agent typed into this session works now (changes come as `agent-activity`). */
  readonly agentWorking: boolean;
  /** The panel's shell was already running: never type a start line into it. */
  readonly attached: boolean;
  /** Not awaited: the next keystroke never waits for this one's round trip. */
  write(data: string): void;
  /** N-06: types agent `agentId`'s start line; the core then watches whether it works and
   * reports when it ends. */
  startAgent(line: string, agentId: string): void;
  resize(cols: number, rows: number): void;
  /** The view is gone; the shell keeps running. */
  detach(): void;
}

/**
 * The last open of each panel. A panel's next open waits for it (React StrictMode mounts a
 * panel twice at once), so the core sees them in order: the first starts the shell, the second
 * attaches, and the first view's late detach changes nothing.
 */
const lastOpen = new Map<string, Promise<unknown>>();

export function openTerminal(options: OpenOptions): Promise<TerminalSession> {
  const previous = lastOpen.get(options.panelId) ?? Promise.resolve();
  const opening = previous.catch(() => undefined).then(() => open(options));
  lastOpen.set(options.panelId, opening);
  void opening
    .finally(() => {
      if (lastOpen.get(options.panelId) === opening) lastOpen.delete(options.panelId);
    })
    .catch(() => undefined);
  return opening;
}

async function open(options: OpenOptions): Promise<TerminalSession> {
  if (options.cancelled?.() === true) throw new OpenCancelled();
  // The ids are known once the open returns; output (the replay first) can arrive before that,
  // so acks wait.
  const view: { ids: { sessionId: number; attachment: number } | undefined; unsent: number } = {
    ids: undefined,
    unsent: 0,
  };
  const ack = createAckCounter((bytes) => {
    if (view.ids === undefined) {
      view.unsent += bytes;
      return;
    }
    report(commands.ptyAck({ ...view.ids, bytes }), "pty ack");
  });
  const stream = new Channel<unknown>((message) => {
    routeStreamMessage(message, {
      onOutput: (data) => {
        options.onOutput(data, () => {
          ack(data.byteLength);
        });
      },
      onExit: options.onExit,
      onCwd: options.onCwd,
      onAgentExit: options.onAgentExit,
    });
  });
  const opened = unwrap(
    await commands.ptyOpen(
      {
        // Lets the core ignore a duplicated delivery of this call.
        requestId: crypto.randomUUID(),
        size: { cols: options.cols, rows: options.rows },
        cwd: options.cwd ?? null,
        profileId: options.profile ?? null,
        panelId: options.panelId,
      },
      stream,
    ),
  );
  const ids = { sessionId: opened.sessionId, attachment: opened.attachment };
  view.ids = ids;
  if (view.unsent > 0) {
    report(commands.ptyAck({ ...ids, bytes: view.unsent }), "pty ack");
    view.unsent = 0;
  }
  // Numbered so the core writes them in typing order, once (IPC calls may overtake each other).
  let seq = 0;
  const write = (data: string, agent: string | undefined) => {
    seq += 1;
    const args = agent === undefined ? { ...ids, seq, data } : { ...ids, seq, data, agent };
    report(commands.ptyWrite(args), "pty write");
  };
  return {
    profileId: opened.profileId,
    integrated: opened.integrated,
    agentExited: opened.agentExited,
    agentWorking: opened.agentWorking,
    attached: opened.attached,
    write: (data) => {
      write(data, undefined);
    },
    startAgent: (line, agentId) => {
      write(line, agentId);
    },
    resize: (cols, rows) => {
      report(commands.ptyResize({ sessionId: ids.sessionId, size: { cols, rows } }), "pty resize");
    },
    detach: () => {
      report(commands.ptyDetach(ids), "pty detach");
    },
  };
}
