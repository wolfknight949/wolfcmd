import { afterEach, describe, expect, it } from "vitest";

import {
  attention,
  clearAttention,
  progress,
  requestAttention,
  setProgress,
  wantsAttention,
} from "./attention";

afterEach(() => {
  attention.setState({}, true);
  progress.setState({}, true);
});

describe("N-02 panel attention", () => {
  it("n02_attention: a request marks the panel unless the user is looking at it", () => {
    requestAttention("p1", "Claude needs your permission", true);
    expect(attention.getState()).toEqual({});
    requestAttention("p1", "Claude needs your permission", false);
    expect(attention.getState()).toEqual({ p1: "Claude needs your permission" });
  });

  it("n02_attention: looking clears it; a repeat changes nothing", () => {
    requestAttention("p1", "Done", false);
    const before = attention.getState();
    requestAttention("p1", "Done", false);
    expect(attention.getState()).toBe(before);
    clearAttention("p1");
    expect(attention.getState()).toEqual({});
    clearAttention("p1");
    expect(attention.getState()).toEqual({});
  });

  it("n02_attention: a tab wants the user while one of its panels does", () => {
    requestAttention("p2", "Bell", false);
    expect(wantsAttention(attention.getState(), ["p1", "p2"])).toBe(true);
    expect(wantsAttention(attention.getState(), ["p3"])).toBe(false);
  });
});

describe("N-02 panel progress", () => {
  it("n02_progress: set, replaced and cleared per panel", () => {
    setProgress("p1", { state: "normal", value: 40 });
    setProgress("p2", { state: "indeterminate", value: 0 });
    setProgress("p1", { state: "error", value: 60 });
    expect(progress.getState()).toEqual({
      p1: { state: "error", value: 60 },
      p2: { state: "indeterminate", value: 0 },
    });
    setProgress("p1", undefined);
    expect(progress.getState()).toEqual({ p2: { state: "indeterminate", value: 0 } });
  });
});
