// N-11: the close question: Cancel has the focus, Esc cancels, Close (with "Don't ask again")
// answers.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { askToClose, type CloseAnswer } from "./close-question";
import { CloseDialog } from "./CloseDialog";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const QUESTION = {
  title: "Close this panel?",
  message: "Claude Code is still running in it.",
  confirm: "Close",
} as const;

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root.render(<CloseDialog />);
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
});

const ask = () => {
  let answer: Promise<CloseAnswer> = Promise.resolve({ close: false, dontAsk: false });
  act(() => {
    answer = askToClose(QUESTION);
  });
  return answer;
};

const button = (name: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent === name);

describe("N-11 the close question", () => {
  it("n11_dialog: names what runs, Cancel has the focus and Esc cancels", async () => {
    const answer = ask();
    expect(document.querySelector("[role=dialog]")?.textContent).toContain(QUESTION.message);
    expect(document.activeElement).toBe(button("Cancel"));
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(await answer).toEqual({ close: false, dontAsk: false });
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });

  it("n11_dialog: Close answers, with Don't ask again when ticked", async () => {
    const answer = ask();
    act(() => {
      document.querySelector<HTMLInputElement>("input[type=checkbox]")?.click();
    });
    act(() => {
      button("Close")?.click();
    });
    expect(await answer).toEqual({ close: true, dontAsk: true });
  });

  it("n11_dialog: a second question cancels the first", async () => {
    const first = ask();
    const second = ask();
    expect(await first).toEqual({ close: false, dontAsk: false });
    act(() => {
      button("Cancel")?.click();
    });
    expect(await second).toEqual({ close: false, dontAsk: false });
  });
});
