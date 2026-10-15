import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipHost } from "./TooltipHost";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderButton() {
  render(
    <>
      <TooltipHost />
      <button type="button" title="Split right">
        Split
      </button>
    </>,
  );
  return screen.getByRole("button", { name: "Split" });
}

function wait(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("one tooltip", () => {
  it("shows a title after the pointer rests, instead of the browser's", () => {
    const button = renderButton();
    act(() => {
      fireEvent.pointerOver(button);
    });
    // The title is held aside, so the browser's own tooltip never shows.
    expect(button.hasAttribute("title")).toBe(false);
    wait(599);
    expect(screen.queryByRole("tooltip")).toBeNull();
    wait(1);
    expect(screen.getByRole("tooltip").textContent).toBe("Split right");
    act(() => {
      fireEvent.pointerOver(document.body);
    });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(button.getAttribute("title")).toBe("Split right");
  });

  it("a press hides it until the pointer moves on", () => {
    const button = renderButton();
    act(() => {
      fireEvent.pointerOver(button);
    });
    wait(600);
    act(() => {
      fireEvent.pointerDown(button);
    });
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => {
      fireEvent.pointerOver(button);
    });
    wait(600);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("shows no tooltip while a mouse button is held (selecting text, dragging)", () => {
    const button = renderButton();
    // The pointer arrives with the button held, as it does while drag-selecting text.
    act(() => {
      fireEvent.pointerOver(button, { buttons: 1 });
    });
    wait(600);
    expect(screen.queryByRole("tooltip")).toBeNull();
    // Released and back on it later: the tooltip works again.
    act(() => {
      fireEvent.pointerOver(document.body);
      fireEvent.pointerOver(button);
    });
    wait(600);
    expect(screen.getByRole("tooltip").textContent).toBe("Split right");
  });

  it("shows on keyboard focus and hides on a key", () => {
    const button = renderButton();
    act(() => {
      fireEvent.keyDown(document.body, { key: "Tab" });
      fireEvent.focusIn(button);
    });
    wait(600);
    expect(screen.getByRole("tooltip").textContent).toBe("Split right");
    // Focus never takes the title away (screen readers keep the description).
    expect(button.getAttribute("title")).toBe("Split right");
    act(() => {
      fireEvent.keyDown(button, { key: "Escape" });
    });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("picks up a title set while the pointer is over the element (Truncate)", async () => {
    render(
      <>
        <TooltipHost />
        <span data-testid="label">A long label</span>
      </>,
    );
    const label = screen.getByTestId("label");
    act(() => {
      fireEvent.pointerOver(label);
    });
    label.setAttribute("title", "A long label");
    // MutationObserver records arrive in a microtask.
    await act(async () => {
      await Promise.resolve();
    });
    expect(label.hasAttribute("title")).toBe(false);
    wait(600);
    expect(screen.getByRole("tooltip").textContent).toBe("A long label");
  });
});
