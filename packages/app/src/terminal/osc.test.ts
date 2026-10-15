import { describe, expect, it } from "vitest";

import {
  CLIPBOARD_LIMIT,
  parseOsc9,
  parseOsc52,
  parseOsc777,
  phaseAfter133,
  sameProgress,
  shiftEnterSequence,
} from "./osc";

describe("N-02 OSC 9", () => {
  it("tells notifications from progress and other sub-commands", () => {
    expect(parseOsc9("Claude needs your permission")).toEqual({
      kind: "notify",
      message: "Claude needs your permission",
    });
    expect(parseOsc9("4;1;42")).toEqual({
      kind: "progress",
      progress: { state: "normal", value: 42 },
    });
    expect(parseOsc9("4;3")).toEqual({
      kind: "progress",
      progress: { state: "indeterminate", value: 0 },
    });
    expect(parseOsc9("4;2;250")).toEqual({
      kind: "progress",
      progress: { state: "error", value: 100 },
    });
    expect(parseOsc9("4;0")).toEqual({ kind: "progress", progress: undefined });
    expect(parseOsc9("4;9;5")).toEqual({ kind: "progress", progress: undefined });
    expect(parseOsc9("9;C:\\src")).toEqual({ kind: "other" });
  });

  it("compares progress reports by value", () => {
    expect(sameProgress({ state: "normal", value: 4 }, { state: "normal", value: 4 })).toBe(true);
    expect(sameProgress({ state: "normal", value: 4 }, { state: "paused", value: 4 })).toBe(false);
    expect(sameProgress(undefined, undefined)).toBe(true);
    expect(sameProgress(undefined, { state: "error", value: 0 })).toBe(false);
  });
});

describe("N-02 OSC 777", () => {
  it("reads notify title and body", () => {
    expect(parseOsc777("notify;Claude Code;Waiting; for input")).toBe(
      "Claude Code: Waiting; for input",
    );
    expect(parseOsc777("notify;Done")).toBe("Done");
    expect(parseOsc777("preexec")).toBeUndefined();
  });
});

describe("N-02 OSC 52", () => {
  it("decodes UTF-8 text and refuses reads, junk and huge payloads", () => {
    expect(parseOsc52("c;aGk=")).toBe("hi");
    expect(parseOsc52(`c;${btoa("caf\u00c3\u00a9")}`)).toBe("café");
    expect(parseOsc52("c;?")).toBeUndefined();
    expect(parseOsc52("c;%%%")).toBeUndefined();
    expect(parseOsc52("nope")).toBeUndefined();
    expect(parseOsc52(`c;${"A".repeat(CLIPBOARD_LIMIT * 2)}`)).toBeUndefined();
  });
});

describe("N-02 Shift+Enter", () => {
  it("is a newline for running programs and Enter at a shell prompt", () => {
    let phase = phaseAfter133("A", "unknown");
    expect(shiftEnterSequence(phase)).toBe("\r");
    phase = phaseAfter133("C", phase);
    expect(shiftEnterSequence(phase)).toBe("\x1b\r");
    phase = phaseAfter133("D;0", phase);
    expect(shiftEnterSequence(phase)).toBe("\r");
    expect(shiftEnterSequence("unknown")).toBe("\x1b\r");
    expect(phaseAfter133("P;k=i", "running")).toBe("running");
  });
});
