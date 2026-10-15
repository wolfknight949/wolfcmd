// N-02: command marks. The shell integration reports each prompt and
// command with OSC 133 (A prompt start, B prompt end, C output start, D end with the exit code).
// Instead of dropping them when a command ends, the terminal keeps the last `MAX_MARKS` commands
// as xterm markers (they follow the lines as the buffer scrolls and are disposed when their line
// is trimmed from the scrollback), for prompt navigation (Ctrl+Up/Down), gutter marks, the
// per-command menu and the sticky header. Pure bookkeeping and geometry, unit-tested with fake
// markers; terminal-view.ts owns the xterm side. Nothing here runs per output chunk.

/** How many commands a terminal remembers (older ones are forgotten first). */
export const MAX_MARKS = 500;

/** The part of an xterm `IMarker` the marks use (fake ones in tests). */
export interface LineMarker {
  /** The buffer line; -1 once disposed (the line was trimmed from the scrollback). */
  readonly line: number;
  readonly isDisposed: boolean;
  dispose(): void;
}

/** A marker and the column it was set at (the cursor's). */
export interface ColumnMark<M extends LineMarker = LineMarker> {
  readonly marker: M;
  readonly x: number;
}

/** One command: its prompt, where the typed line starts, its output, its end and exit code. */
export interface CommandMark<M extends LineMarker = LineMarker> {
  /** Stable for the terminal's life (menus and the sticky header refer to it). */
  readonly id: number;
  /** `OSC 133;A` (or the first mark seen for a prompt without A). */
  readonly prompt: M;
  /** `OSC 133;B`: the end of the prompt, where the typed command starts. */
  promptEnd: ColumnMark<M> | undefined;
  /** `OSC 133;C`: where the output starts. */
  output: M | undefined;
  /** `OSC 133;D`: where the output ends. */
  end: ColumnMark<M> | undefined;
  /** From `OSC 133;D;<code>`; `undefined` when the shell didn't say. */
  exitCode: number | undefined;
  /** The command line, read once at `C` ("" when it couldn't be read). */
  command: string;
}

/** `prompt`: waiting at the prompt; `running`: output started, no end yet; `done`: ended. */
export type MarkState = "prompt" | "running" | "done";

/** What the UI shows about a command (an immutable copy, safe for React). */
export interface MarkInfo {
  readonly id: number;
  readonly command: string;
  readonly exitCode: number | undefined;
  readonly state: MarkState;
}

/** A command that ended with a code other than 0 (shown red-toned, announced). */
export function isFailure(exitCode: number | undefined): exitCode is number {
  return exitCode !== undefined && exitCode !== 0;
}

/** The neutral and failed colors a mark takes on the overview ruler. */
export interface RulerColors {
  readonly neutral: string;
  readonly failure: string;
}

/**
 * A command's mark on the overview ruler (the scrollbar's track): a slim line across the whole
 * track, like the find matches. xterm draws its `left` / `center` / `right` lanes 6 to 12 px
 * tall, which read as thick bars beside the text; only `full` is a thin line.
 */
export function rulerMark(exitCode: number | undefined, colors: RulerColors) {
  return {
    color: isFailure(exitCode) ? colors.failure : colors.neutral,
    position: "full" as const,
  };
}

/**
 * The ring of command marks. A new command beyond `limit` forgets the oldest one; marks whose
 * prompt line was trimmed from the scrollback are forgotten when next looked at. `onDrop` gets
 * every forgotten mark (after its markers were disposed), for the view's decorations.
 */
export class MarkRing<M extends LineMarker = LineMarker> {
  private marks: CommandMark<M>[] = [];
  private nextId = 1;
  /** The shell reports command starts (`C`): a prompt without one was an empty line. */
  private reportsStarts = false;

  constructor(
    private readonly limit = MAX_MARKS,
    private readonly onDrop: (mark: CommandMark<M>) => void = () => undefined,
  ) {}

  /** The newest mark (the prompt the shell shows now, or the command running). */
  current(): CommandMark<M> | undefined {
    return this.marks[this.marks.length - 1];
  }

  /** `OSC 133;A`: a new prompt. `make` is only called when a marker is needed. */
  prompt(make: () => M): CommandMark<M> {
    const last = this.current();
    // A prompt that never ran a command (Enter on an empty line, Ctrl+C at the prompt) is not a
    // command, in shells that report command starts; cmd reports none, so its prompts stay.
    if (last !== undefined && last.output === undefined && this.reportsStarts) {
      this.drop(last);
    }
    return this.push(make());
  }

  /**
   * Marks at or below a new prompt's line were cleared off the screen (`cls`, Ctrl+L: the
   * prompt starts at the top again); their lines are blank now.
   */
  private dropFrom(line: number): void {
    if (line < 0) return;
    for (const mark of this.marks.filter((m) => m.prompt.line >= line)) this.drop(mark);
  }

  /** `OSC 133;B`: the end of the prompt (a B without A starts the mark itself). */
  promptEnd(make: () => M, x: number): CommandMark<M> {
    const last = this.current();
    if (last === undefined || last.output !== undefined || last.end !== undefined) {
      const marker = make();
      const mark = this.push(marker);
      mark.promptEnd = { marker, x };
      return mark;
    }
    // A prompt drawn again (a resize, a prompt tool) moves the end.
    if (last.promptEnd !== undefined && last.promptEnd.marker !== last.prompt) {
      last.promptEnd.marker.dispose();
    }
    last.promptEnd = { marker: make(), x };
    return last;
  }

  /** `OSC 133;C`: the command started. Nothing without a prompt to belong to. */
  outputStart(make: () => M): CommandMark<M> | undefined {
    const last = this.current();
    if (last === undefined || last.end !== undefined) return undefined;
    this.reportsStarts = true;
    if (last.output !== undefined) last.output.dispose();
    last.output = make();
    return last;
  }

  /**
   * `OSC 133;D`: the running command ended. A command line that was empty and reports no code
   * (PowerShell's Enter on an empty line) is forgotten. Returns the ended mark.
   */
  end(make: () => ColumnMark<M>, exitCode: number | undefined): CommandMark<M> | undefined {
    const last = this.current();
    if (last?.output === undefined || last.end !== undefined) return undefined;
    if (last.command.trim() === "" && exitCode === undefined) {
      this.drop(last);
      return undefined;
    }
    last.end = make();
    last.exitCode = exitCode;
    return last;
  }

  /** The marks whose lines are still in the buffer, oldest first. */
  live(): readonly CommandMark<M>[] {
    // Trimming takes lines from the top, so trimmed marks are the oldest ones; a cleared
    // scrollback (`clear`, `cls`) disposes them all.
    const first = this.marks[0];
    if (first !== undefined && isGone(first)) {
      for (const mark of this.marks.filter(isGone)) this.drop(mark);
    }
    return this.marks;
  }

  get(id: number): CommandMark<M> | undefined {
    return this.live().find((mark) => mark.id === id);
  }

  /** The newest command that ran (running or done), not the prompt waiting for one. */
  lastCommand(): CommandMark<M> | undefined {
    const marks = this.live();
    for (let i = marks.length - 1; i >= 0; i -= 1) {
      const mark = marks[i];
      if (mark?.output !== undefined) return mark;
    }
    return undefined;
  }

  /** The mark after `mark` (its next prompt), if any. */
  after(mark: CommandMark<M>): CommandMark<M> | undefined {
    const marks = this.live();
    const index = marks.indexOf(mark);
    return index === -1 ? undefined : marks[index + 1];
  }

  /** The state of a mark (only the newest one can still be at its prompt or running). */
  stateOf(mark: CommandMark<M>): MarkState {
    if (mark.end !== undefined) return "done";
    if (mark !== this.current()) return "done"; // a later prompt: it ended without a D
    return mark.output === undefined ? "prompt" : "running";
  }

  info(mark: CommandMark<M>): MarkInfo {
    return {
      id: mark.id,
      command: mark.command,
      exitCode: mark.exitCode,
      state: this.stateOf(mark),
    };
  }

  /** Forgets every mark (the terminal is disposed). */
  dispose(): void {
    for (const mark of [...this.marks]) this.drop(mark);
  }

  private push(prompt: M): CommandMark<M> {
    this.dropFrom(prompt.line);
    const mark: CommandMark<M> = {
      id: this.nextId,
      prompt,
      promptEnd: undefined,
      output: undefined,
      end: undefined,
      exitCode: undefined,
      command: "",
    };
    this.nextId += 1;
    this.marks.push(mark);
    for (let oldest = this.marks[0]; this.marks.length > this.limit; oldest = this.marks[0]) {
      if (oldest === undefined) break;
      this.drop(oldest);
    }
    return mark;
  }

  private drop(mark: CommandMark<M>): void {
    const index = this.marks.indexOf(mark);
    if (index !== -1) this.marks.splice(index, 1);
    for (const marker of [mark.prompt, mark.promptEnd?.marker, mark.output, mark.end?.marker]) {
      if (marker !== undefined && !marker.isDisposed) marker.dispose();
    }
    this.onDrop(mark);
  }
}

function isGone(mark: CommandMark): boolean {
  return mark.prompt.isDisposed || mark.prompt.line < 0;
}

/** Rows of the buffer: `from`…`to` (inclusive), the first from column `fromX`, the last up to `toX`. */
export interface RowRange {
  readonly from: number;
  readonly to: number;
  readonly fromX: number;
  /** The last row ends at this column (exclusive); `undefined`: the whole row. */
  readonly toX: number | undefined;
}

/**
 * Where a command's output is in the buffer: from `C` to `D` (the row of `D` only up to its
 * column; `D` at column 0 is the next prompt's row), or to the next prompt, or to `cursorLine`
 * while it runs. `undefined` without output, or when its lines are gone.
 */
export function outputRange(
  mark: CommandMark,
  next: CommandMark | undefined,
  cursorLine: number,
): RowRange | undefined {
  const from = mark.output?.line;
  if (from === undefined || from < 0) return undefined;
  let to: number;
  let toX: number | undefined;
  if (mark.end !== undefined && mark.end.marker.line >= 0) {
    to = mark.end.x === 0 ? mark.end.marker.line - 1 : mark.end.marker.line;
    toX = mark.end.x === 0 ? undefined : mark.end.x;
  } else if (next !== undefined && next.prompt.line >= 0) {
    to = next.prompt.line - 1;
  } else {
    to = cursorLine;
  }
  if (to < from) return { from, to: from - 1, fromX: 0, toX: undefined }; // printed nothing
  return { from, to, fromX: 0, toX };
}

/** The whole command block: its prompt down to the end of its output (for Shift+Ctrl+Up/Down). */
export function blockRange(
  mark: CommandMark,
  next: CommandMark | undefined,
  cursorLine: number,
): { readonly start: number; readonly end: number } | undefined {
  const start = mark.prompt.line;
  if (start < 0) return undefined;
  const output = outputRange(mark, next, cursorLine);
  const typed = mark.promptEnd?.marker.line ?? start;
  const end = Math.max(start, typed, output === undefined ? start : output.to);
  return { start, end };
}

/** The navigation keys, only on the normal screen (a TUI on the alternate screen keeps them). */
export type MarkKey = "up" | "down" | "selectUp" | "selectDown";

/**
 * Ctrl+Up/Down jumps between prompts, Shift+Ctrl+Up/Down selects whole commands (VS
 * Code's and Ghostty's keys; Cmd instead of Ctrl on macOS, `apple`). Never on the alternate
 * screen, where a full-screen program (vim, htop, an agent's TUI) owns every key.
 */
export function markKey(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">,
  screen: "normal" | "alternate",
  apple = false,
): MarkKey | undefined {
  if (screen !== "normal") return undefined;
  const primary = apple ? event.metaKey : event.ctrlKey;
  const other = apple ? event.ctrlKey : event.metaKey;
  if (!primary || other || event.altKey) return undefined;
  if (event.key === "ArrowUp") return event.shiftKey ? "selectUp" : "up";
  if (event.key === "ArrowDown") return event.shiftKey ? "selectDown" : "down";
  return undefined;
}

/** Where the viewport is, in buffer lines. */
export interface ViewportLines {
  /** The first line shown. */
  readonly viewportY: number;
  /** The first line of the bottom page (`viewportY === baseY`: scrolled to the bottom). */
  readonly baseY: number;
  /** The cursor's buffer line. */
  readonly cursorLine: number;
}

/** The last jump: the prompt line it went to and where that left the viewport. */
export interface LastJump {
  readonly line: number;
  readonly viewportY: number;
}

/**
 * The line navigation counts from: the prompt of the last jump while the viewport is still
 * where that jump left it (a prompt near the bottom can't scroll to the top); at the bottom,
 * the prompt waiting for input (so Up goes to the command before it) or below the cursor (so
 * Up goes to the running command); else the top of the viewport.
 */
export function referenceLine(
  view: ViewportLines,
  last: LastJump | undefined,
  waiting: CommandMark | undefined,
): number {
  if (last?.viewportY === view.viewportY) return last.line;
  if (view.viewportY >= view.baseY) {
    const waitingLine = waiting?.prompt.line ?? -1;
    return waitingLine >= 0 ? waitingLine : view.cursorLine + 1;
  }
  return view.viewportY;
}

/**
 * The prompt to jump to from `from`: the nearest one above (`up`) or below (`down`).
 * `undefined`: none (Down then scrolls to the bottom). `prompts` are ascending lines.
 */
export function jumpTarget(
  prompts: readonly number[],
  from: number,
  direction: "up" | "down",
): number | undefined {
  if (direction === "up") {
    for (let i = prompts.length - 1; i >= 0; i -= 1) {
      const line = prompts[i];
      if (line !== undefined && line < from) return line;
    }
    return undefined;
  }
  for (const line of prompts) {
    if (line > from) return line;
  }
  return undefined;
}

/** The marks navigation goes through: every live mark except a prompt still waiting at the bottom. */
export function navigable<M extends LineMarker>(ring: MarkRing<M>): readonly CommandMark<M>[] {
  const marks = ring.live();
  const last = marks[marks.length - 1];
  if (last !== undefined && ring.stateOf(last) === "prompt") return marks.slice(0, -1);
  return marks;
}

/**
 * The index of the mark whose block holds `line`: the last one whose prompt is at or above
 * it. -1 when `line` is above every prompt. Binary search: called while scrolling.
 */
export function markIndexAt(marks: readonly CommandMark[], line: number): number {
  let low = 0;
  let high = marks.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const prompt = marks[middle]?.prompt.line ?? -1;
    if (prompt <= line) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/** Shift+Ctrl+Up/Down: the commands selected, from `anchor` to `focus` (indices of navigable marks). */
export interface CommandSelection {
  readonly anchor: number;
  readonly focus: number;
}

/**
 * the next command selection. The first Shift+Ctrl+Up selects the command `start`
 * points at (the one a jump would go to); more presses grow or shrink it a command at a time,
 * the anchor staying where it began. `undefined` when there is nothing to select.
 */
export function moveSelection(
  selection: CommandSelection | undefined,
  direction: "up" | "down",
  start: number | undefined,
  count: number,
): CommandSelection | undefined {
  if (count === 0) return undefined;
  if (selection === undefined) {
    if (start === undefined) return undefined;
    return { anchor: start, focus: start };
  }
  const step = direction === "up" ? -1 : 1;
  const focus = Math.min(count - 1, Math.max(0, selection.focus + step));
  return { anchor: selection.anchor, focus };
}

/**
 * the command to show in the sticky header: the one whose output the top of the
 * viewport is in, while its prompt is scrolled out of view. Only while the user scrolled up
 * (at the bottom the terminal follows the output and the header would hide its first line).
 */
export function stickyMark<M extends LineMarker>(
  marks: readonly CommandMark<M>[],
  view: Pick<ViewportLines, "viewportY" | "baseY">,
): CommandMark<M> | undefined {
  if (view.viewportY >= view.baseY) return undefined;
  const index = markIndexAt(marks, view.viewportY);
  const mark = marks[index];
  if (mark?.output === undefined) return undefined;
  const top = view.viewportY;
  if (mark.prompt.line >= top || mark.output.line > top) return undefined;
  const next = marks[index + 1];
  const end = mark.end?.marker.line ?? next?.prompt.line;
  if (end !== undefined && end >= 0 && top >= end) return undefined;
  return mark;
}

/** Which per-command actions a mark's menu offers now: `true` enabled, `false` shown dimmed (the
 * user sees it exists and why not now), `undefined` not shown at all. */
export interface MarkActions {
  /** The command line could be read. */
  readonly copyCommand: boolean;
  /** It printed something (or is printing). */
  readonly copyOutput: boolean;
  /** Selects its output in the terminal (then Ctrl+C copies it, a drag extends it). */
  readonly selectOutput: boolean;
  /** The shell waits at an idle prompt on the normal screen, and a one-line command to type. */
  readonly rerun: boolean;
  /** It printed something to search. */
  readonly find: boolean;
  /** Only while it runs: the panel asks for attention when it ends. */
  readonly notify: boolean | undefined;
}

/** The actions of one command (pure: the menu shows exactly these). */
export function markActions(
  info: MarkInfo,
  where: { readonly idlePrompt: boolean; readonly hasOutput: boolean },
): MarkActions {
  const typed = info.command.trim() !== "";
  return {
    copyCommand: typed,
    copyOutput: where.hasOutput,
    selectOutput: where.hasOutput,
    rerun: typed && where.idlePrompt && !info.command.trim().includes("\n"),
    find: where.hasOutput,
    notify: info.state === "running" ? true : undefined,
  };
}

/** A command line taller than this many rows was not read (a stale prompt mark). */
export const MAX_COMMAND_ROWS = 50;

/** One row of the terminal buffer; `wrapped` rows continue the row above. */
export interface BufferRow {
  readonly text: string;
  readonly wrapped: boolean;
}

/** Buffer rows → lines: a wrapped row continues the line above; trailing blanks are dropped. */
export function logicalLines(rows: readonly BufferRow[]): string[] {
  const lines: string[] = [];
  for (const row of rows) {
    if (row.wrapped && lines.length > 0) {
      lines[lines.length - 1] = (lines[lines.length - 1] ?? "") + row.text;
    } else {
      lines.push(row.text);
    }
  }
  return lines.map((line) => line.trimEnd());
}

/** A command line in one short line (tooltips, the sticky header, the menu): `npm test …`. */
export function commandSummary(command: string, max = 60): string {
  const lines = command
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const first = lines[0] ?? "";
  const text = first.length > max ? `${first.slice(0, max - 1)}…` : first;
  return lines.length > 1 && !text.endsWith("…") ? `${text} …` : text;
}

/** A command that ran this long asks for attention when it ends where the user isn't looking. */
export const LONG_COMMAND_MS = 10_000;

/** `9s`, `1m 12s`, `1h 5m`. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60)}s`;
  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`;
}

/**
 * What the panel says when a command it was asked about (Notify me) or a long one ends:
 * "Finished: npm test", "Finished with exit code 1 after 1m 12s: npm test".
 */
export function finishedMessage(
  command: string,
  exitCode: number | undefined,
  durationMs?: number,
): string {
  const name = commandSummary(command) || "A command";
  const after = durationMs === undefined ? "" : ` after ${formatDuration(durationMs)}`;
  return exitCode === undefined || exitCode === 0
    ? `Finished${after}: ${name}`
    : `Finished with exit code ${String(exitCode)}${after}: ${name}`;
}
