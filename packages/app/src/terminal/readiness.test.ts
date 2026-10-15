import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createReadiness, READY_FALLBACK_MS, READY_SETTLE_MS } from "./readiness";

describe("N-02 readiness of a terminal's shell", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("an attached session never types its agent line", () => {
    const onReady = vi.fn();
    const readiness = createReadiness(onReady);
    readiness.prompt(); // the replay or new output can carry prompts
    readiness.started(true, true);
    readiness.prompt();
    vi.advanceTimersByTime(READY_FALLBACK_MS * 10);
    expect(onReady).not.toHaveBeenCalled();
  });

  it("a new shell is ready shortly after its first prompt, once", () => {
    const onReady = vi.fn();
    const readiness = createReadiness(onReady);
    readiness.started(false, true);
    readiness.prompt();
    vi.advanceTimersByTime(READY_SETTLE_MS);
    expect(onReady).toHaveBeenCalledOnce();
    readiness.prompt();
    vi.advanceTimersByTime(READY_FALLBACK_MS * 10);
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("a prompt before the open returned counts", () => {
    const onReady = vi.fn();
    const readiness = createReadiness(onReady);
    readiness.prompt();
    readiness.started(false, true);
    vi.advanceTimersByTime(READY_SETTLE_MS);
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("N-06 a shell without integration is ready after the fallback (about 5 s)", () => {
    expect(READY_FALLBACK_MS).toBe(5000);
    const onReady = vi.fn();
    const readiness = createReadiness(onReady);
    readiness.started(false, false);
    vi.advanceTimersByTime(READY_FALLBACK_MS - 1);
    expect(onReady).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("N-06 a shell with integration waits for its prompt however slow its profile is", () => {
    const onReady = vi.fn();
    const readiness = createReadiness(onReady);
    readiness.started(false, true);
    vi.advanceTimersByTime(READY_FALLBACK_MS * 6);
    expect(onReady).not.toHaveBeenCalled();
    readiness.prompt();
    vi.advanceTimersByTime(READY_SETTLE_MS);
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("a disposed view is never ready", () => {
    const onReady = vi.fn();
    const readiness = createReadiness(onReady);
    readiness.started(false, false);
    readiness.dispose();
    vi.advanceTimersByTime(READY_FALLBACK_MS * 10);
    expect(onReady).not.toHaveBeenCalled();
  });
});
