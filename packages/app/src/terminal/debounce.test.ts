import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { debounce } from "./debounce";

describe("N-03 PTY resize is debounced until the size is stable", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends only the last size of a drag", () => {
    const resize = vi.fn();
    const debounced = debounce(resize, 50);
    debounced.call(80, 24);
    vi.advanceTimersByTime(30);
    debounced.call(90, 24);
    vi.advanceTimersByTime(30);
    debounced.call(100, 30);
    expect(resize).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(resize).toHaveBeenCalledExactlyOnceWith(100, 30);
  });

  it("cancel drops a pending call", () => {
    const resize = vi.fn();
    const debounced = debounce(resize, 50);
    debounced.call(80, 24);
    debounced.cancel();
    vi.advanceTimersByTime(100);
    expect(resize).not.toHaveBeenCalled();
  });
});

describe("N-03 the shell reflows once, when a resize settles", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("N-03 a drag of a frame per step sends one size, the last", () => {
    const resize = vi.fn();
    const debounced = debounce(resize, 100);
    for (let cols = 80; cols <= 140; cols += 1) {
      debounced.call(cols, 30);
      vi.advanceTimersByTime(16);
    }
    expect(resize).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(resize).toHaveBeenCalledExactlyOnceWith(140, 30);
  });

  it("N-03 flush sends the waiting size at once (a released divider), and only once", () => {
    const resize = vi.fn();
    const debounced = debounce(resize, 100);
    debounced.call(90, 24);
    debounced.call(100, 24);
    expect(debounced.pending()).toBe(true);
    debounced.flush();
    expect(resize).toHaveBeenCalledExactlyOnceWith(100, 24);
    expect(debounced.pending()).toBe(false);
    vi.advanceTimersByTime(200);
    debounced.flush();
    expect(resize).toHaveBeenCalledTimes(1);
  });

  it("N-03 flush with nothing waiting does nothing", () => {
    const resize = vi.fn();
    const debounced = debounce(resize, 100);
    debounced.flush();
    debounced.call(80, 24);
    debounced.cancel();
    debounced.flush();
    expect(debounced.pending()).toBe(false);
    expect(resize).not.toHaveBeenCalled();
  });
});
