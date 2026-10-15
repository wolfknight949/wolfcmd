import { describe, expect, it, vi } from "vitest";

import {
  blockRange,
  commandSummary,
  finishedMessage,
  formatDuration,
  type CommandMark,
  jumpTarget,
  logicalLines,
  type LineMarker,
  markActions,
  markIndexAt,
  markKey,
  MarkRing,
  MAX_MARKS,
  moveSelection,
  navigable,
  outputRange,
  referenceLine,
  rulerMark,
  stickyMark,
} from "./marks";

/** An xterm marker stand-in: a line that becomes -1 when disposed (trimmed). */
class FakeMarker implements LineMarker {
  isDisposed = false;
  constructor(public line: number) {}
  dispose(): void {
    this.isDisposed = true;
    this.line = -1;
  }
}

const at = (line: number) => () => new FakeMarker(line);
const colAt =
  (line: number, x = 0) =>
  () => ({ marker: new FakeMarker(line), x });

/** A full command: prompt at `line`, typed on it, output from the next line, ended at `end`. */
function run(
  ring: MarkRing<FakeMarker>,
  line: number,
  command: string,
  end: number,
  exitCode: number | undefined = 0,
): CommandMark<FakeMarker> | undefined {
  ring.prompt(at(line));
  ring.promptEnd(at(line), 4);
  const mark = ring.outputStart(at(line + 1));
  if (mark !== undefined) mark.command = command;
  return ring.end(colAt(end), exitCode);
}

describe("N-02 the ring of command marks", () => {
  it("n02_ring_bounds: forgets the oldest commands beyond the limit and disposes them", () => {
    const dropped = vi.fn();
    const ring = new MarkRing<FakeMarker>(3, dropped);
    const first = run(ring, 0, "one", 2);
    for (let i = 1; i < 5; i += 1) run(ring, i * 3, `cmd ${String(i)}`, i * 3 + 2);
    const live = ring.live();
    expect(live).toHaveLength(3);
    expect(live.map((mark) => mark.command)).toEqual(["cmd 2", "cmd 3", "cmd 4"]);
    expect(dropped).toHaveBeenCalledTimes(2);
    expect(first?.prompt.isDisposed).toBe(true);
    expect(first?.output?.isDisposed).toBe(true);
    expect(first?.end?.marker.isDisposed).toBe(true);
  });

  it("n02_ring_bounds: keeps about 500 commands by default", () => {
    const ring = new MarkRing<FakeMarker>();
    for (let i = 0; i < MAX_MARKS + 20; i += 1) run(ring, i * 3, "x", i * 3 + 2);
    expect(ring.live()).toHaveLength(MAX_MARKS);
    expect(MAX_MARKS).toBe(500);
  });

  it("n02_ring_trimming: a command whose prompt was trimmed from the scrollback is forgotten", () => {
    const dropped = vi.fn();
    const ring = new MarkRing<FakeMarker>(10, dropped);
    const first = run(ring, 0, "old", 2);
    run(ring, 3, "new", 5);
    first?.prompt.dispose(); // xterm disposes markers of trimmed lines
    expect(ring.live().map((mark) => mark.command)).toEqual(["new"]);
    expect(dropped).toHaveBeenCalledOnce();
    expect(first?.output?.isDisposed).toBe(true);
  });

  it("n02_ring_trimming: a cleared scrollback forgets every command", () => {
    const ring = new MarkRing<FakeMarker>();
    const marks = [run(ring, 0, "a", 2), run(ring, 3, "b", 5)];
    for (const mark of marks) mark?.prompt.dispose();
    expect(ring.live()).toHaveLength(0);
  });

  it("n02_clear_screen: a prompt drawn at the top again forgets the marks below it", () => {
    const ring = new MarkRing<FakeMarker>();
    run(ring, 10, "a", 12);
    run(ring, 13, "b", 15);
    ring.prompt(at(10)); // `cls`: the next prompt starts where the screen begins
    expect(ring.live().map((mark) => mark.command)).toEqual([""]);
  });

  it("n02_empty_prompts: a prompt that never ran a command is not a command", () => {
    const ring = new MarkRing<FakeMarker>();
    run(ring, 0, "ls", 2);
    ring.prompt(at(3)); // Ctrl+C at the prompt
    ring.promptEnd(at(3), 4);
    ring.prompt(at(4));
    expect(ring.live().map((mark) => mark.prompt.line)).toEqual([0, 4]);
  });

  it("n02_empty_prompts: PowerShell's Enter on an empty line (C, then D without a code) is forgotten", () => {
    const ring = new MarkRing<FakeMarker>();
    run(ring, 0, "ls", 2);
    ring.prompt(at(3));
    ring.promptEnd(at(3), 4);
    ring.outputStart(at(4));
    expect(ring.end(colAt(4), undefined)).toBeUndefined();
    expect(ring.live()).toHaveLength(1);
  });

  it("n02_cmd_prompts: a shell without command starts (cmd) keeps every prompt", () => {
    const ring = new MarkRing<FakeMarker>();
    ring.prompt(at(0));
    ring.promptEnd(at(0), 4);
    ring.prompt(at(2));
    ring.prompt(at(4));
    expect(ring.live().map((mark) => mark.prompt.line)).toEqual([0, 2, 4]);
    expect(ring.lastCommand()).toBeUndefined();
  });

  it("n02_states: at the prompt, running, done (also when the next prompt comes without D)", () => {
    const ring = new MarkRing<FakeMarker>();
    const mark = ring.prompt(at(0));
    expect(ring.stateOf(mark)).toBe("prompt");
    ring.outputStart(at(1));
    expect(ring.stateOf(mark)).toBe("running");
    ring.prompt(at(5)); // the shell lost the D
    expect(ring.stateOf(mark)).toBe("done");
    expect(ring.info(mark)).toEqual({
      id: mark.id,
      command: "",
      exitCode: undefined,
      state: "done",
    });
  });

  it("n02_promptEnd: B without A starts its own mark; B again moves the end", () => {
    const ring = new MarkRing<FakeMarker>();
    const mark = ring.promptEnd(at(0), 2);
    expect(mark.prompt).toBe(mark.promptEnd?.marker);
    const old = mark.promptEnd?.marker;
    ring.promptEnd(at(0), 6);
    expect(mark.promptEnd?.x).toBe(6);
    expect(old?.isDisposed).toBe(false); // it is also the prompt marker
  });

  it("n02_outputStart: C without a prompt is ignored", () => {
    const ring = new MarkRing<FakeMarker>();
    expect(ring.outputStart(at(0))).toBeUndefined();
    expect(ring.live()).toHaveLength(0);
  });

  it("n02_lastCommand: the newest command that ran, not the prompt waiting after it", () => {
    const ring = new MarkRing<FakeMarker>();
    run(ring, 0, "first", 2);
    const second = run(ring, 3, "second", 5, 1);
    ring.prompt(at(6));
    expect(ring.lastCommand()).toBe(second);
    expect(ring.lastCommand()?.exitCode).toBe(1);
    expect(navigable(ring).map((mark) => mark.command)).toEqual(["first", "second"]);
  });

  it("n02_dispose: forgets everything", () => {
    const dropped = vi.fn();
    const ring = new MarkRing<FakeMarker>(10, dropped);
    run(ring, 0, "a", 2);
    run(ring, 3, "b", 5);
    ring.dispose();
    expect(ring.live()).toHaveLength(0);
    expect(dropped).toHaveBeenCalledTimes(2);
  });
});

describe("N-02 ranges", () => {
  it("n02_output_range: from C to the row before D (D at column 0)", () => {
    const ring = new MarkRing<FakeMarker>();
    const mark = run(ring, 0, "ls", 5);
    expect(mark && outputRange(mark, undefined, 99)).toEqual({
      from: 1,
      to: 4,
      fromX: 0,
      toX: undefined,
    });
  });

  it("n02_output_range: D in the middle of a row ends the output there", () => {
    const ring = new MarkRing<FakeMarker>();
    ring.prompt(at(0));
    const mark = ring.outputStart(at(1));
    ring.end(colAt(3, 7), 2);
    expect(mark && outputRange(mark, undefined, 99)).toEqual({ from: 1, to: 3, fromX: 0, toX: 7 });
  });

  it("n02_output_range: while running, to the cursor; printed nothing: empty", () => {
    const ring = new MarkRing<FakeMarker>();
    ring.prompt(at(0));
    const running = ring.outputStart(at(1));
    expect(running && outputRange(running, undefined, 8)?.to).toBe(8);
    const silent = run(ring, 10, "true", 11);
    const range = silent && outputRange(silent, undefined, 99);
    expect(range !== undefined && range.to < range.from).toBe(true);
  });

  it("n02_block_range: the prompt down to the end of the output", () => {
    const ring = new MarkRing<FakeMarker>();
    const mark = run(ring, 2, "ls", 7);
    expect(mark && blockRange(mark, undefined, 99)).toEqual({ start: 2, end: 6 });
  });
});

describe("N-02 navigation", () => {
  it("n02_alternate_screen: the keys are only the terminal's on the normal screen", () => {
    const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({
      key: k,
      ctrlKey: true,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      ...mods,
    });
    expect(markKey(key("ArrowUp"), "normal")).toBe("up");
    expect(markKey(key("ArrowDown"), "normal")).toBe("down");
    expect(markKey(key("ArrowUp", { shiftKey: true }), "normal")).toBe("selectUp");
    expect(markKey(key("ArrowDown", { shiftKey: true }), "normal")).toBe("selectDown");
    expect(markKey(key("ArrowUp"), "alternate")).toBeUndefined();
    expect(markKey(key("ArrowUp", { altKey: true }), "normal")).toBeUndefined();
    expect(markKey(key("ArrowUp", { ctrlKey: false }), "normal")).toBeUndefined();
    expect(markKey(key("ArrowLeft"), "normal")).toBeUndefined();
    // macOS: Cmd+Up/Down; Ctrl+Up stays the program's.
    const cmd = { ctrlKey: false, metaKey: true };
    expect(markKey(key("ArrowUp", cmd), "normal", true)).toBe("up");
    expect(markKey(key("ArrowUp"), "normal", true)).toBeUndefined();
    expect(markKey(key("ArrowUp", cmd), "normal")).toBeUndefined();
  });

  it("n02_jump_order: the nearest prompt above or below", () => {
    const prompts = [0, 10, 20, 30];
    expect(jumpTarget(prompts, 25, "up")).toBe(20);
    expect(jumpTarget(prompts, 20, "up")).toBe(10);
    expect(jumpTarget(prompts, 0, "up")).toBeUndefined();
    expect(jumpTarget(prompts, 10, "down")).toBe(20);
    expect(jumpTarget(prompts, 30, "down")).toBeUndefined();
    expect(jumpTarget([], 5, "up")).toBeUndefined();
  });

  it("n02_jump_order: counts from the last jump while the view stayed where it went", () => {
    const view = { viewportY: 40, baseY: 40, cursorLine: 60 };
    // A prompt near the bottom can't scroll to the top: the next Up starts from it anyway.
    expect(referenceLine(view, { line: 55, viewportY: 40 }, undefined)).toBe(55);
    // The user scrolled since: from the top of the viewport.
    expect(referenceLine({ ...view, viewportY: 12 }, { line: 55, viewportY: 40 }, undefined)).toBe(
      12,
    );
  });

  it("n02_jump_order: at the bottom, Up goes to the command before the waiting prompt, or the running one", () => {
    const ring = new MarkRing<FakeMarker>();
    run(ring, 0, "a", 3);
    const waiting = ring.prompt(at(4));
    const view = { viewportY: 0, baseY: 0, cursorLine: 4 };
    expect(referenceLine(view, undefined, waiting)).toBe(4);
    expect(jumpTarget([0], referenceLine(view, undefined, waiting), "up")).toBe(0);
    // A command running at the bottom: its own prompt is above the cursor.
    expect(referenceLine({ ...view, cursorLine: 9 }, undefined, undefined)).toBe(10);
  });

  it("n02_selection: Shift+Ctrl+Up selects a command, more presses grow and shrink it", () => {
    let selection = moveSelection(undefined, "up", 3, 5);
    expect(selection).toEqual({ anchor: 3, focus: 3 });
    selection = moveSelection(selection, "up", undefined, 5);
    selection = moveSelection(selection, "up", undefined, 5);
    expect(selection).toEqual({ anchor: 3, focus: 1 });
    selection = moveSelection(selection, "down", undefined, 5);
    expect(selection).toEqual({ anchor: 3, focus: 2 });
    // Clamped to the commands there are.
    expect(moveSelection({ anchor: 0, focus: 0 }, "up", undefined, 5)).toEqual({
      anchor: 0,
      focus: 0,
    });
    expect(moveSelection({ anchor: 4, focus: 4 }, "down", undefined, 5)).toEqual({
      anchor: 4,
      focus: 4,
    });
    expect(moveSelection(undefined, "up", undefined, 5)).toBeUndefined();
    expect(moveSelection(undefined, "up", 0, 0)).toBeUndefined();
  });

  it("n02_mark_at: the command whose block holds a line", () => {
    const ring = new MarkRing<FakeMarker>();
    run(ring, 0, "a", 4);
    run(ring, 5, "b", 9);
    run(ring, 10, "c", 14);
    const marks = ring.live();
    expect(markIndexAt(marks, 7)).toBe(1);
    expect(markIndexAt(marks, 10)).toBe(2);
    expect(markIndexAt(marks, 100)).toBe(2);
    expect(markIndexAt([], 3)).toBe(-1);
  });
});

describe("N-02 sticky command header", () => {
  const ring = new MarkRing<FakeMarker>();
  run(ring, 0, "npm test", 50, 1);
  run(ring, 51, "ls", 55);
  const marks = ring.live();

  it("n02_sticky: the command whose output the top of the viewport is in", () => {
    expect(stickyMark(marks, { viewportY: 20, baseY: 60 })?.command).toBe("npm test");
  });

  it("n02_sticky: nothing while its prompt or typed line is visible at the top", () => {
    expect(stickyMark(marks, { viewportY: 0, baseY: 60 })).toBeUndefined();
    expect(stickyMark(marks, { viewportY: 51, baseY: 60 })).toBeUndefined();
  });

  it("n02_sticky: nothing at the bottom (the terminal follows its output)", () => {
    expect(stickyMark(marks, { viewportY: 60, baseY: 60 })).toBeUndefined();
  });

  it("n02_sticky: nothing above the first prompt", () => {
    const later = new MarkRing<FakeMarker>();
    run(later, 30, "x", 40);
    expect(stickyMark(later.live(), { viewportY: 10, baseY: 60 })).toBeUndefined();
  });
});

describe("N-02 per-command actions", () => {
  const info = { id: 1, command: "npm test", exitCode: 1, state: "done" as const };

  it("n02_actions: everything for a finished command at an idle prompt", () => {
    expect(markActions(info, { idlePrompt: true, hasOutput: true })).toEqual({
      copyCommand: true,
      copyOutput: true,
      selectOutput: true,
      rerun: true,
      find: true,
      notify: undefined,
    });
  });

  it("n02_actions: Rerun only at an idle prompt and for one line; output actions need output", () => {
    const busy = markActions(info, { idlePrompt: false, hasOutput: false });
    expect(busy.rerun).toBe(false);
    expect(busy.copyOutput).toBe(false);
    expect(busy.selectOutput).toBe(false);
    expect(busy.find).toBe(false);
    const multi = { ...info, command: "a\nb" };
    expect(markActions(multi, { idlePrompt: true, hasOutput: true }).rerun).toBe(false);
    const unknown = { ...info, command: "" };
    const actions = markActions(unknown, { idlePrompt: true, hasOutput: true });
    expect(actions.copyCommand).toBe(false);
    expect(actions.rerun).toBe(false);
  });

  it("n02_actions: Notify me only while it runs", () => {
    const running = { ...info, exitCode: undefined, state: "running" as const };
    expect(markActions(running, { idlePrompt: false, hasOutput: true }).notify).toBe(true);
  });
});

describe("N-02 command text", () => {
  it("n02_lines: wrapped rows join their line and trailing blanks go", () => {
    expect(
      logicalLines([
        { text: "npm te", wrapped: false },
        { text: "st   ", wrapped: true },
        { text: "ok  ", wrapped: false },
      ]),
    ).toEqual(["npm test", "ok"]);
  });

  it("n02_summary: the first line, shortened, with … for more", () => {
    expect(commandSummary("  npm test  ")).toBe("npm test");
    expect(commandSummary("a\nb")).toBe("a …");
    expect(commandSummary("x".repeat(80), 10)).toBe(`${"x".repeat(9)}…`);
    expect(commandSummary("")).toBe("");
  });
});

describe("N-02 finished commands", () => {
  it("n02_duration: says how long it took", () => {
    expect(formatDuration(9_000)).toBe("9s");
    expect(formatDuration(72_000)).toBe("1m 12s");
    expect(formatDuration(3_900_000)).toBe("1h 5m");
  });

  it("n02_finished: names the command, its exit code and its time", () => {
    expect(finishedMessage("npm test", 0)).toBe("Finished: npm test");
    expect(finishedMessage("npm test", 1, 72_000)).toBe(
      "Finished with exit code 1 after 1m 12s: npm test",
    );
    expect(finishedMessage("", undefined)).toBe("Finished: A command");
  });
});

describe("N-02 the overview ruler", () => {
  it("n02_ruler_mark: a slim line across the scrollbar's track, red-toned when it failed", () => {
    const colors = { neutral: "#888", failure: "#f00" };
    // `full` is xterm's only thin lane (the others are 6 to 12 px tall bars).
    expect(rulerMark(undefined, colors)).toEqual({ color: "#888", position: "full" });
    expect(rulerMark(0, colors)).toEqual({ color: "#888", position: "full" });
    expect(rulerMark(2, colors)).toEqual({ color: "#f00", position: "full" });
  });
});
